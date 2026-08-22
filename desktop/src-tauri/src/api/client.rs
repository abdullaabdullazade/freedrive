use crate::api::types::*;

use crate::auth_store::{save_auth, StoredAuth};

use crate::crypto::{self, generate_file_key, key_to_b64url};

use crate::db::{delete_pending_file_key, store_file_key, store_pending_file_key, DbHandle};

use crate::error::{AppError, AppResult};

use rand::RngCore;

use reqwest::multipart::{Form, Part};

use std::path::{Path, PathBuf};

use std::sync::Arc;

use std::time::Duration;

use parking_lot::RwLock;

fn desktop_device_name() -> String {
    hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Desktop".to_string())
}

fn http_api_error(status: reqwest::StatusCode, text: &str) -> AppError {
    let code = status.as_u16();
    if let Ok(err) = serde_json::from_str::<ApiError>(text) {
        return AppError::http(code, err.error);
    }
    if text.trim().is_empty() {
        return AppError::http(code, format!("request failed ({code})"));
    }
    AppError::http(code, text.to_string())
}

fn is_transient_gateway_status(status: reqwest::StatusCode) -> bool {
    matches!(
        status,
        reqwest::StatusCode::BAD_GATEWAY
            | reqwest::StatusCode::SERVICE_UNAVAILABLE
            | reqwest::StatusCode::GATEWAY_TIMEOUT
    )
}

fn is_transient_http_error(msg: &str) -> bool {
    let lower = msg.to_ascii_lowercase();
    lower.contains("http 502")
        || lower.contains("http 503")
        || lower.contains("http 504")
        || lower.contains("bad gateway")
        || lower.contains("service unavailable")
        || lower.contains("gateway timeout")
        || lower.contains("error sending request")
        || lower.contains("decoding response body")
        || lower.contains("download connect failed")
        || lower.contains("download interrupted")
        || lower.contains("connection")
        || lower.contains("timed out")
        || lower.contains("timeout")
        || lower.contains("reset")
        || lower.contains("interrupted")
}

fn is_missing_blob_message(msg: &str) -> bool {
    let lower = msg.to_ascii_lowercase();
    lower.contains("failed to read file")
        || lower.contains("blob missing")
        || lower.contains("blob unreadable")
}

async fn classify_probe_response(res: reqwest::Response) -> AppResult<bool> {
    let status = res.status();
    if status.is_success() {
        // Drop body without buffering — connection closes on drop.
        drop(res);
        return Ok(true);
    }
    let text = res.text().await.unwrap_or_default();
    if status.as_u16() == 404 || status.as_u16() == 500 {
        if is_missing_blob_message(&text) || text.trim().is_empty() {
            return Ok(false);
        }
        // 404 "file not found" from metadata also means not downloadable.
        if status.as_u16() == 404 {
            return Ok(false);
        }
    }
    Err(http_api_error(status, &text))
}

fn desktop_device_id() -> String {
    crate::auth_store::device_id().unwrap_or_else(|_| uuid::Uuid::new_v4().to_string())
}

fn apply_device_headers(req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
    req.header("X-Device-Type", "desktop")
        .header("X-Device-Name", desktop_device_name())
        .header("X-Device-ID", desktop_device_id())
}

#[derive(Clone)]

pub struct ApiClient {

    inner: Arc<RwLock<ClientInner>>,

}



struct ClientInner {

    server_url: String,

    access_token: String,

    refresh_token: String,

    http: reqwest::Client,

    upload_http: reqwest::Client,

    upload_limit_bps: u64,

    download_limit_bps: u64,

}



struct PreparedUpload {
    body: UploadBody,
    key: [u8; 32],
    name: String,
    mime: String,
    iv_b64: String,
    original_size: usize,
    folder_id: Option<String>,
}

enum UploadBody {
    TempFile(PathBuf),
    Memory(Vec<u8>),
}

/// Files at or below this size are encrypted in RAM (no temp file on disk).
const SMALL_UPLOAD_BYTES: u64 = 1_048_576;
/// Ciphertext larger than this uses resumable chunked upload (Cloudflare-safe).
const RESUMABLE_THRESHOLD: u64 = 32 * 1024 * 1024;
const RESUMABLE_CHUNK: usize = 8 * 1024 * 1024;

/// `(bytes_sent, bytes_total)` for UI progress rings.
pub type UploadProgressCb = Arc<dyn Fn(u64, u64) + Send + Sync>;

fn report_progress(on_progress: Option<&UploadProgressCb>, sent: u64, total: u64) {
    if let Some(cb) = on_progress {
        cb(sent, total);
    }
}



impl ApiClient {

    pub async fn register(
        server_url: &str,
        email: &str,
        username: &str,
        password: &str,
        invite_code: &str,
    ) -> AppResult<User> {
        let base = server_url.trim_end_matches('/');
        let http = reqwest::Client::new();
        let res = apply_device_headers(http.post(format!("{}/api/v1/auth/register", base)))
            .json(&serde_json::json!({
                "email": email,
                "username": username,
                "password": password,
                "invite_code": invite_code,
            }))
            .send()
            .await?;
        let status = res.status();
        let text = res.text().await?;
        if !status.is_success() {
            return Err(http_api_error(status, &text));
        }
        let response: RegistrationResponse = serde_json::from_str(&text)?;
        Ok(response.user)
    }

    pub fn from_auth(auth: &StoredAuth) -> Self {

        Self::from_auth_with_network(auth, "", "", "", 0, 0)

            .unwrap_or_else(|_| Self::from_auth_unchecked(auth))

    }

    fn from_auth_unchecked(auth: &StoredAuth) -> Self {

        Self::from_auth_with_network(auth, "", "", "", 0, 0)

            .expect("default HTTP client configuration")

    }

    pub fn from_auth_with_network(

        auth: &StoredAuth,

        proxy_url: &str,

        proxy_username: &str,

        proxy_password: &str,

        upload_limit_kbps: u64,

        download_limit_kbps: u64,

    ) -> AppResult<Self> {

        let server_url = auth.server_url.trim_end_matches('/').to_string();

        let mut http_builder = reqwest::Client::builder()

            .timeout(Duration::from_secs(600));

        let mut upload_builder = reqwest::Client::builder()

            .timeout(Duration::from_secs(120));

        let proxy_url = proxy_url.trim();

        if !proxy_url.is_empty() {

            let mut proxy = reqwest::Proxy::all(proxy_url)

                .map_err(|e| AppError::msg(format!("invalid proxy URL: {e}")))?;

            if !proxy_username.is_empty() {
                proxy = proxy.basic_auth(proxy_username, proxy_password);
            }

            http_builder = http_builder.proxy(proxy.clone());

            upload_builder = upload_builder.proxy(proxy);

        }

        let http = http_builder.build()?;

        let upload_http = upload_builder.build()?;

        Ok(Self {

            inner: Arc::new(RwLock::new(ClientInner {

                server_url,

                access_token: auth.access_token.clone(),

                refresh_token: auth.refresh_token.clone(),

                http,

                upload_http,

                upload_limit_bps: upload_limit_kbps.saturating_mul(1024),

                download_limit_bps: download_limit_kbps.saturating_mul(1024),

            })),

        })

    }

    pub fn configure_network(

        &self,

        proxy_url: &str,

        proxy_username: &str,

        proxy_password: &str,

        upload_limit_kbps: u64,

        download_limit_kbps: u64,

    ) -> AppResult<()> {

        let auth = {

            let inner = self.inner.read();

            StoredAuth {

                server_url: inner.server_url.clone(),

                access_token: inner.access_token.clone(),

                refresh_token: inner.refresh_token.clone(),

                user_json: String::new(),

            }

        };

        let configured = Self::from_auth_with_network(

            &auth,

            proxy_url,

            proxy_username,

            proxy_password,

            upload_limit_kbps,

            download_limit_kbps,

        )?;

        let configured = configured.inner.read();

        let mut inner = self.inner.write();

        inner.http = configured.http.clone();

        inner.upload_http = configured.upload_http.clone();

        inner.upload_limit_bps = configured.upload_limit_bps;

        inner.download_limit_bps = configured.download_limit_bps;

        Ok(())

    }



    pub fn server_url(&self) -> String {

        self.inner.read().server_url.clone()

    }

    /// Fast, unauthenticated readiness probe used before starting a full scan.
    pub async fn check_health(&self) -> AppResult<()> {
        let (url, http) = {
            let inner = self.inner.read();
            (
                format!("{}/api/v1/health", inner.server_url),
                inner.http.clone(),
            )
        };
        let response = tokio::time::timeout(
            Duration::from_secs(5),
            http.get(url).timeout(Duration::from_secs(5)).send(),
        )
            .await
            .map_err(|_| AppError::msg("server health check timed out"))??;
        let status = response.status();
        let text = response.text().await?;
        if !status.is_success() {
            return Err(http_api_error(status, &text));
        }
        let payload: serde_json::Value = serde_json::from_str(&text)?;
        if payload.get("status").and_then(|value| value.as_str()) != Some("ok") {
            return Err(AppError::msg("server health check returned an invalid response"));
        }
        Ok(())
    }



    fn api_url(&self, path: &str) -> String {

        let inner = self.inner.read();

        format!("{}/api/v1{}", inner.server_url, path)

    }



    async fn request_json<T: serde::de::DeserializeOwned>(

        &self,

        method: reqwest::Method,

        path: &str,

        body: Option<serde_json::Value>,

        retry: bool,

        rl_retries: u32,

    ) -> AppResult<T> {

        let url = self.api_url(path);

        let (access_token, http) = {

            let inner = self.inner.read();

            (inner.access_token.clone(), inner.http.clone())

        };



        let mut req = http.request(method.clone(), &url);

        req = req.header("Authorization", format!("Bearer {}", access_token));

        if let Some(ref b) = body {

            req = req.json(b);

        }



        let res = req.send().await?;

        if res.status() == reqwest::StatusCode::UNAUTHORIZED

            && !retry

            && path != "/auth/login"

            && path != "/auth/refresh"

        {

            if self.try_refresh().await? {

                return Box::pin(self.request_json(method, path, body, true, rl_retries)).await;

            }

            return Err(AppError::msg("session expired"));

        }



        if res.status() == reqwest::StatusCode::TOO_MANY_REQUESTS && rl_retries > 0 {

            tokio::time::sleep(Duration::from_millis(400)).await;

            return Box::pin(self.request_json(method, path, body, retry, rl_retries - 1)).await;

        }

        if is_transient_gateway_status(res.status()) && rl_retries > 0 {
            tokio::time::sleep(Duration::from_millis(400)).await;
            return Box::pin(self.request_json(method, path, body, retry, rl_retries - 1)).await;
        }



        let status = res.status();

        let text = res.text().await?;

        if !status.is_success() {
            return Err(http_api_error(status, &text));
        }



        serde_json::from_str(&text).map_err(|e| {
            let preview: String = text.chars().take(200).collect();
            AppError::msg(format!("API JSON decode failed: {e}; body={preview}"))
        })

    }



    pub async fn try_refresh(&self) -> AppResult<bool> {

        let (url, refresh_token, http) = {

            let inner = self.inner.read();

            (

                format!("{}/api/v1/auth/refresh", inner.server_url),

                inner.refresh_token.clone(),

                inner.http.clone(),

            )

        };



        let res = apply_device_headers(http.post(&url))

            .json(&serde_json::json!({ "refresh_token": refresh_token }))

            .send()

            .await?;



        if !res.status().is_success() {

            return Ok(false);

        }



        let data: RefreshResponse = res.json().await?;

        {

            let mut inner = self.inner.write();

            inner.access_token = data.tokens.access_token.clone();

            inner.refresh_token = data.tokens.refresh_token.clone();

        }



        if let Ok(Some(mut auth)) = crate::auth_store::load_auth() {

            auth.access_token = data.tokens.access_token;

            auth.refresh_token = data.tokens.refresh_token;

            let _ = save_auth(&auth);

        }



        Ok(true)

    }



    pub async fn login(

        server_url: &str,

        email: &str,

        password: &str,

    ) -> AppResult<serde_json::Value> {

        let base = server_url.trim_end_matches('/');

        let http = reqwest::Client::new();

        let res = apply_device_headers(http.post(format!("{}/api/v1/auth/login", base)))

            .json(&serde_json::json!({ "email": email, "password": password }))

            .send()

            .await?;



        let status = res.status();

        let text = res.text().await?;

        if !status.is_success() {

            if let Ok(err) = serde_json::from_str::<ApiError>(&text) {

                return Err(AppError::msg(err.error));

            }

            return Err(AppError::msg("login failed"));

        }

        serde_json::from_str(&text).map_err(Into::into)

    }




    pub async fn poll_login_approval(
        server_url: &str,
        challenge_id: &str,
        challenge_token: &str,
    ) -> AppResult<serde_json::Value> {
        let base = server_url.trim_end_matches('/');
        let http = reqwest::Client::new();
        let encoded = challenge_token
            .bytes()
            .map(|b| match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                    (b as char).to_string()
                }
                _ => format!("%{:02X}", b),
            })
            .collect::<String>();
        let url = format!(
            "{}/api/v1/auth/login-approval/{}?token={}",
            base, challenge_id, encoded
        );
        let res = apply_device_headers(http.get(url)).send().await?;
        let status = res.status();
        let text = res.text().await?;
        if !status.is_success() {
            if let Ok(err) = serde_json::from_str::<ApiError>(&text) {
                return Err(AppError::msg(err.error));
            }
            return Err(AppError::msg("login approval poll failed"));
        }
        serde_json::from_str(&text).map_err(Into::into)
    }

    pub async fn verify_2fa(challenge_id: &str, code: &str, server_url: &str) -> AppResult<LoginSuccess> {

        let base = server_url.trim_end_matches('/');

        let http = reqwest::Client::new();

        let res = apply_device_headers(http.post(format!("{}/api/v1/auth/verify-2fa", base)))

            .json(&serde_json::json!({ "challenge_id": challenge_id, "code": code }))

            .send()

            .await?;



        let status = res.status();

        let text = res.text().await?;

        if !status.is_success() {

            if let Ok(err) = serde_json::from_str::<ApiError>(&text) {

                return Err(AppError::msg(err.error));

            }

            return Err(AppError::msg("2FA verification failed"));

        }

        serde_json::from_str(&text).map_err(Into::into)

    }

    pub async fn send_2fa_email(challenge_id: &str, server_url: &str) -> AppResult<serde_json::Value> {
        let base = server_url.trim_end_matches('/');
        let http = reqwest::Client::new();
        let res = apply_device_headers(http.post(format!("{}/api/v1/auth/2fa/send-email", base)))
            .json(&serde_json::json!({ "challenge_id": challenge_id }))
            .send()
            .await?;

        let status = res.status();
        let text = res.text().await?;
        if !status.is_success() {
            if let Ok(err) = serde_json::from_str::<ApiError>(&text) {
                return Err(AppError::msg(err.error));
            }
            return Err(AppError::msg("failed to send verification code"));
        }
        serde_json::from_str(&text).map_err(Into::into)
    }



    pub async fn get_me(&self) -> AppResult<User> {
        self.request_json(reqwest::Method::GET, "/me", None, false, 2)
            .await
    }

    pub async fn get_my_storage(&self) -> AppResult<StorageInfo> {
        self.request_json(reqwest::Method::GET, "/me/storage", None, false, 2)
            .await
    }

    pub async fn get_my_drive_root(&self) -> AppResult<FolderContents> {
        self.fetch_all_folder_pages("/folders/root").await
    }

    pub async fn get_shared_with_me(&self) -> AppResult<Vec<SharedItem>> {
        let resp: SharedWithMeResponse = self
            .request_json(reqwest::Method::GET, "/shares/with-me", None, false, 2)
            .await?;
        Ok(resp.items)
    }

    pub async fn get_shared_by_me(&self) -> AppResult<Vec<SharedItem>> {
        let resp: SharedWithMeResponse = self
            .request_json(reqwest::Method::GET, "/shares/by-me", None, false, 2)
            .await?;
        Ok(resp.items)
    }

    pub async fn logout(&self) -> AppResult<()> {

        let refresh_token = self.inner.read().refresh_token.clone();

        let _: serde_json::Value = self

            .request_json(

                reqwest::Method::POST,

                "/auth/logout",

                Some(serde_json::json!({ "refresh_token": refresh_token })),

                false,

                2,

            )

            .await?;

        Ok(())

    }



    pub async fn register_computer(&self, name: &str, hostname: &str) -> AppResult<Computer> {

        self.request_json(

            reqwest::Method::POST,

            "/computers/register",

            Some(serde_json::json!({ "name": name, "hostname": hostname })),

            false,

            2,

        )

        .await

    }



    pub async fn heartbeat(&self, computer_id: &str) -> AppResult<Computer> {

        self.request_json(

            reqwest::Method::POST,

            &format!("/computers/{}/heartbeat", computer_id),

            None,

            false,

            2,

        )

        .await

    }



    pub async fn create_folder(

        &self,

        name: &str,

        parent_id: Option<&str>,

    ) -> AppResult<Folder> {

        self.request_json(

            reqwest::Method::POST,

            "/folders",

            Some(serde_json::json!({

                "name": name,

                "parent_id": parent_id

            })),

            false,

            2,

        )

        .await

    }



    pub async fn resolve_folder_by_name(

        &self,

        parent_id: &str,

        name: &str,

    ) -> AppResult<Option<Folder>> {

        let contents = self.get_folder_contents(parent_id).await?;

        Ok(contents

            .folders

            .into_iter()

            .find(|f| f.name == name))

    }



    pub async fn create_or_resolve_folder(
        &self,
        name: &str,
        parent_id: Option<&str>,
    ) -> AppResult<Folder> {
        match self.create_folder(name, parent_id).await {
            Ok(folder) => Ok(folder),
            Err(e) => {
                crate::sync::log::sync_log(format!(
                    "create_folder '{}' failed ({}), resolving by name",
                    name, e
                ));
                let contents = match parent_id {
                    Some(parent) => self.get_folder_contents(parent).await?,
                    None => self.get_my_drive_root().await?,
                };
                contents
                    .folders
                    .into_iter()
                    .find(|f| f.name == name)
                    .ok_or_else(|| AppError::msg(format!("folder not found: {}", name)))
            }
        }
    }



    pub async fn get_folder_contents(&self, folder_id: &str) -> AppResult<FolderContents> {
        self.fetch_all_folder_pages(&format!("/folders/{}", folder_id))
            .await
    }

    pub async fn get_file(&self, file_id: &str) -> AppResult<FileRecord> {
        self.request_json(
            reqwest::Method::GET,
            &format!("/files/{file_id}"),
            None,
            false,
            2,
        )
        .await
    }

    pub async fn search_drive(&self, query: &str) -> AppResult<crate::api::types::SearchResult> {
        let path = format!(
            "/search?q={}&location=My%20Drive&page_size=100",
            urlencoding::encode(query.trim())
        );
        self.request_json(reqwest::Method::GET, &path, None, false, 2)
            .await
    }

    pub async fn list_all_folders(&self) -> AppResult<Vec<Folder>> {
        let response: FoldersResponse = self
            .request_json(reqwest::Method::GET, "/folders/all", None, false, 2)
            .await?;
        Ok(response.folders)
    }

    pub async fn update_drive_item(
        &self,
        item_type: &str,
        item_id: &str,
        body: serde_json::Value,
    ) -> AppResult<()> {
        let collection = if item_type == "folder" { "folders" } else { "files" };
        let _: serde_json::Value = self
            .request_json(
                reqwest::Method::PATCH,
                &format!("/{collection}/{item_id}"),
                Some(body),
                false,
                2,
            )
            .await?;
        Ok(())
    }

    pub async fn get_file_versions(&self, file_id: &str) -> AppResult<Vec<FileVersion>> {
        let response: FileVersionsResponse = self
            .request_json(
                reqwest::Method::GET,
                &format!("/files/{file_id}/versions"),
                None,
                false,
                2,
            )
            .await?;
        Ok(response.versions)
    }

    pub async fn restore_file_version(&self, file_id: &str, version: i32) -> AppResult<FileRecord> {
        self.request_json(
            reqwest::Method::POST,
            &format!("/files/{file_id}/versions/{version}/restore"),
            Some(serde_json::json!({})),
            false,
            2,
        )
        .await
    }

    pub async fn create_user_share(
        &self,
        item_type: &str,
        item_id: &str,
        email: &str,
        permission: &str,
    ) -> AppResult<UserShareRecord> {
        let mut body = serde_json::json!({
            "shared_email": email,
            "permission": permission,
        });
        body[if item_type == "folder" { "folder_id" } else { "file_id" }] =
            serde_json::Value::String(item_id.to_owned());
        self.request_json(reqwest::Method::POST, "/shares/users", Some(body), false, 2)
            .await
    }

    pub async fn create_share_link(
        &self,
        item_type: &str,
        item_id: &str,
        password: &str,
    ) -> AppResult<ShareLink> {
        let mut body = serde_json::json!({
            "permission": "read",
            "password": password,
        });
        body[if item_type == "folder" { "folder_id" } else { "file_id" }] =
            serde_json::Value::String(item_id.to_owned());
        self.request_json(reqwest::Method::POST, "/shares/links", Some(body), false, 2)
            .await
    }

    pub async fn list_share_links(&self) -> AppResult<Vec<ShareLink>> {
        let response: ShareLinksResponse = self
            .request_json(reqwest::Method::GET, "/shares/links", None, false, 2)
            .await?;
        Ok(response.links)
    }

    pub async fn update_user_share(&self, share_id: &str, permission: &str) -> AppResult<()> {
        let _: UserShareRecord = self
            .request_json(
                reqwest::Method::PATCH,
                &format!("/shares/users/{share_id}"),
                Some(serde_json::json!({ "permission": permission })),
                false,
                2,
            )
            .await?;
        Ok(())
    }

    pub async fn delete_user_share(&self, share_id: &str) -> AppResult<()> {
        let _: serde_json::Value = self
            .request_json(reqwest::Method::DELETE, &format!("/shares/users/{share_id}"), None, false, 2)
            .await?;
        Ok(())
    }

    pub async fn delete_share_link(&self, link_id: &str) -> AppResult<()> {
        let _: serde_json::Value = self
            .request_json(reqwest::Method::DELETE, &format!("/shares/links/{link_id}"), None, false, 2)
            .await?;
        Ok(())
    }

    /// Fetch every page of folder contents so sync/orphan walks see the full set.
    async fn fetch_all_folder_pages(&self, base_path: &str) -> AppResult<FolderContents> {
        const PAGE_SIZE: u32 = 500;
        let mut page_token: Option<String> = None;
        let mut merged = FolderContents {
            folder: None,
            folders: Vec::new(),
            files: Vec::new(),
            next_page_token: None,
            total_files: None,
        };
        let mut guard = 0u32;
        loop {
            guard += 1;
            if guard > 10_000 {
                return Err(AppError::msg("folder listing exceeded page limit"));
            }
            let mut path = format!("{}?page_size={}", base_path, PAGE_SIZE);
            if let Some(ref token) = page_token {
                path.push_str("&page_token=");
                path.push_str(&urlencoding::encode(token));
            }
            let page: FolderContents = self
                .request_json(reqwest::Method::GET, &path, None, false, 2)
                .await?;
            if merged.folder.is_none() {
                merged.folder = page.folder;
            }
            if !page.folders.is_empty() {
                merged.folders = page.folders;
            }
            if let Some(total) = page.total_files {
                merged.total_files = Some(total);
            }
            merged.files.extend(page.files);
            let next = page.next_page_token.filter(|t| !t.is_empty());
            if next.is_none() {
                merged.next_page_token = None;
                break;
            }
            page_token = next;
        }
        Ok(merged)
    }

    pub async fn delete_file(&self, file_id: &str) -> AppResult<()> {
        self.delete_file_with_mutation(file_id, None).await
    }

    pub async fn delete_file_with_mutation(
        &self,
        file_id: &str,
        client_mutation_id: Option<&str>,
    ) -> AppResult<()> {
        match self
            .request_json_mutation::<serde_json::Value>(
                reqwest::Method::DELETE,
                &format!("/files/{}", file_id),
                None,
                client_mutation_id,
                false,
                2,
            )
            .await
        {
            Ok(_) => Ok(()),
            Err(e) => {
                if e.is_not_found() {
                    Ok(())
                } else {
                    Err(e)
                }
            }
        }
    }

    pub async fn delete_folder_with_mutation(
        &self,
        folder_id: &str,
        client_mutation_id: Option<&str>,
    ) -> AppResult<()> {
        match self
            .request_json_mutation::<serde_json::Value>(
                reqwest::Method::DELETE,
                &format!("/folders/{}", folder_id),
                None,
                client_mutation_id,
                false,
                2,
            )
            .await
        {
            Ok(_) => Ok(()),
            Err(e) => {
                if e.is_not_found() {
                    Ok(())
                } else {
                    Err(e)
                }
            }
        }
    }

    pub async fn patch_file(
        &self,
        file_id: &str,
        name: Option<&str>,
        folder_id: Option<&str>,
        client_mutation_id: Option<&str>,
    ) -> AppResult<FileRecord> {
        let mut body = serde_json::Map::new();
        if let Some(n) = name {
            body.insert("name".into(), serde_json::Value::String(n.to_string()));
        }
        if let Some(fid) = folder_id {
            body.insert("folder_id".into(), serde_json::Value::String(fid.to_string()));
        }
        self.request_json_mutation(
            reqwest::Method::PATCH,
            &format!("/files/{}", file_id),
            Some(serde_json::Value::Object(body)),
            client_mutation_id,
            false,
            2,
        )
        .await
    }

    pub async fn patch_folder(
        &self,
        folder_id: &str,
        name: Option<&str>,
        parent_id: Option<&str>,
        client_mutation_id: Option<&str>,
    ) -> AppResult<Folder> {
        let mut body = serde_json::Map::new();
        if let Some(n) = name {
            body.insert("name".into(), serde_json::Value::String(n.to_string()));
        }
        if let Some(pid) = parent_id {
            body.insert("parent_id".into(), serde_json::Value::String(pid.to_string()));
        }
        let value: serde_json::Value = self
            .request_json_mutation(
                reqwest::Method::PATCH,
                &format!("/folders/{}", folder_id),
                Some(serde_json::Value::Object(body)),
                client_mutation_id,
                false,
                2,
            )
            .await?;
        // New API returns Folder; older servers returned {"message":"updated"}.
        if let Ok(folder) = serde_json::from_value::<Folder>(value.clone()) {
            if !folder.id.is_empty() {
                return Ok(folder);
            }
        }
        if value
            .get("message")
            .and_then(|m| m.as_str())
            .is_some_and(|m| m.eq_ignore_ascii_case("updated"))
        {
            return Ok(Folder {
                id: folder_id.to_string(),
                name: name.unwrap_or("").to_string(),
                parent_id: parent_id.map(|s| s.to_string()),
                is_trashed: false,
                is_starred: false,
            });
        }
        Err(AppError::msg(format!(
            "unexpected PATCH /folders response: {}",
            value
        )))
    }

    pub async fn get_computer_snapshot(&self, computer_id: &str) -> AppResult<ComputerSnapshot> {
        self.request_json(
            reqwest::Method::GET,
            &format!("/computers/{}/snapshot", computer_id),
            None,
            false,
            2,
        )
        .await
    }

    pub async fn get_computer_changes(
        &self,
        computer_id: &str,
        cursor: i64,
        limit: u32,
    ) -> AppResult<SyncChangesResponse> {
        self.request_json(
            reqwest::Method::GET,
            &format!("/computers/{}/changes?cursor={}&limit={}", computer_id, cursor, limit),
            None,
            false,
            2,
        )
        .await
    }

    async fn request_json_mutation<T: serde::de::DeserializeOwned>(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<serde_json::Value>,
        client_mutation_id: Option<&str>,
        retry: bool,
        rl_retries: u32,
    ) -> AppResult<T> {
        let url = self.api_url(path);
        let (access_token, http) = {
            let inner = self.inner.read();
            (inner.access_token.clone(), inner.http.clone())
        };

        let mut req = http.request(method.clone(), &url);
        req = req.header("Authorization", format!("Bearer {}", access_token));
        if let Some(id) = client_mutation_id {
            req = req.header("X-Client-Mutation-Id", id);
        }
        if let Some(ref b) = body {
            req = req.json(b);
        }

        let res = req.send().await?;
        if res.status() == reqwest::StatusCode::UNAUTHORIZED
            && !retry
            && path != "/auth/login"
            && path != "/auth/refresh"
        {
            if self.try_refresh().await? {
                return Box::pin(self.request_json_mutation(
                    method,
                    path,
                    body,
                    client_mutation_id,
                    true,
                    rl_retries,
                ))
                .await;
            }
            return Err(AppError::msg("session expired"));
        }

        if res.status() == reqwest::StatusCode::TOO_MANY_REQUESTS && rl_retries > 0 {
            tokio::time::sleep(Duration::from_millis(400)).await;
            return Box::pin(self.request_json_mutation(
                method,
                path,
                body,
                client_mutation_id,
                retry,
                rl_retries - 1,
            ))
            .await;
        }

        if is_transient_gateway_status(res.status()) && rl_retries > 0 {
            tokio::time::sleep(Duration::from_millis(400)).await;
            return Box::pin(self.request_json_mutation(
                method,
                path,
                body,
                client_mutation_id,
                retry,
                rl_retries - 1,
            ))
            .await;
        }

        let status = res.status();
        let text = res.text().await?;
        if status.is_success() {
            if text.is_empty() {
                return Ok(serde_json::from_str("null")?);
            }
            return serde_json::from_str(&text).map_err(|e| {
                let preview: String = text.chars().take(200).collect();
                AppError::msg(format!("API JSON decode failed: {e}; body={preview}"))
            });
        }
        Err(http_api_error(status, &text))
    }



    fn prepare_upload(
        local_path: &Path,
        name: &str,
        folder_id: Option<&str>,
        existing_key: Option<[u8; 32]>,
    ) -> AppResult<PreparedUpload> {
        let plaintext = std::fs::read(local_path)?;
        let original_size = plaintext.len();
        let mime = mime_guess::from_path(local_path)
            .first_or_octet_stream()
            .to_string();

        let key = existing_key.unwrap_or_else(generate_file_key);
        let (ciphertext, iv) = crypto::encrypt_file(&plaintext, &key)?;

        let body = if (original_size as u64) <= SMALL_UPLOAD_BYTES {
            UploadBody::Memory(ciphertext)
        } else {
            let mut temp_path = std::env::temp_dir();
            let mut suffix = [0u8; 8];
            rand::thread_rng().fill_bytes(&mut suffix);
            temp_path.push(format!("freedrive-upload-{}.enc", hex::encode(suffix)));
            std::fs::write(&temp_path, &ciphertext)?;
            UploadBody::TempFile(temp_path)
        };

        Ok(PreparedUpload {
            body,
            key,
            name: name.to_string(),
            mime,
            iv_b64: crypto::iv_to_base64(&iv),
            original_size,
            folder_id: folder_id.map(|s| s.to_string()),
        })
    }

    fn cleanup_prepared(prepared: &PreparedUpload) {
        if let UploadBody::TempFile(path) = &prepared.body {
            let _ = std::fs::remove_file(path);
        }
    }



    pub async fn upload_file(
        &self,
        db: &DbHandle,
        local_path: &Path,
        name: &str,
        folder_id: Option<&str>,
        on_progress: Option<UploadProgressCb>,
    ) -> AppResult<(FileRecord, [u8; 32])> {
        self.upload_multipart_with_retry(
            Some(db),
            "/files/upload",
            local_path,
            name,
            folder_id,
            None,
            on_progress,
        )
        .await
    }



    pub async fn update_file_content(

        &self,

        file_id: &str,

        local_path: &Path,

        name: &str,

        existing_key: Option<[u8; 32]>,

        on_progress: Option<UploadProgressCb>,

    ) -> AppResult<(FileRecord, [u8; 32])> {

        self.upload_multipart_with_retry(

            None,

            &format!("/files/{}/content", file_id),

            local_path,

            name,

            None,

            existing_key,

            on_progress,

        )

        .await

    }



    async fn upload_multipart_with_retry(

        &self,

        db: Option<&DbHandle>,

        path: &str,

        local_path: &Path,

        name: &str,

        folder_id: Option<&str>,

        existing_key: Option<[u8; 32]>,

        on_progress: Option<UploadProgressCb>,

    ) -> AppResult<(FileRecord, [u8; 32])> {

        let mut auth_retry = false;

        let mut rl_retries = 2u32;

        let mut transient_retries = 3u32;
        let backoff_ms = [200u64, 500, 1000];



        loop {

            let file_size = std::fs::metadata(local_path)

                .map(|m| m.len())

                .unwrap_or(0);

            let prep_timeout = crate::blocking::upload_prep_timeout(file_size);

            let http_timeout = crate::blocking::upload_http_timeout(file_size);



            let prepared = {

                let local_path = local_path.to_path_buf();

                let name = name.to_string();

                let folder_id = folder_id.map(|s| s.to_string());



                crate::blocking::run_blocking_with_timeout_async(prep_timeout, move || {

                    Self::prepare_upload(

                        &local_path,

                        &name,

                        folder_id.as_deref(),

                        existing_key,

                    )

                })

                .await?



            };



            if let (Some(db), Some(folder_id)) = (db, prepared.folder_id.as_deref()) {

                if existing_key.is_none() {

                    let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;

                    store_pending_file_key(

                        &conn,

                        folder_id,

                        &prepared.name,

                        &key_to_b64url(&prepared.key),

                    )?;

                }

            }



            crate::sync::log::sync_log(format!(

                "encrypt ok {} ({} bytes)",

                prepared.name,

                prepared.original_size

            ));



            crate::sync::log::sync_log(format!(

                "http start {} ({})",

                prepared.name,

                path

            ));



            let cipher_len = match &prepared.body {
                UploadBody::Memory(v) => v.len() as u64,
                UploadBody::TempFile(p) => std::fs::metadata(p).map(|m| m.len()).unwrap_or(0),
            };

            let upload_limited = self.inner.read().upload_limit_bps > 0;
            let upload_result: AppResult<crate::api::types::FileRecord> = if cipher_len > RESUMABLE_THRESHOLD || upload_limited {
                let replace_id = path
                    .strip_prefix("/files/")
                    .and_then(|rest| rest.strip_suffix("/content"))
                    .map(|s| s.to_string());
                self.resumable_stream_once(
                    &prepared,
                    replace_id.as_deref(),
                    http_timeout,
                    on_progress.as_ref(),
                )
                .await
            } else {
                self.multipart_stream_once(path, &prepared, http_timeout, on_progress.as_ref())
                    .await
            };



            Self::cleanup_prepared(&prepared);



            match upload_result {

                Ok(rec) => {

                    let key_b64 = key_to_b64url(&prepared.key);

                    if let Some(db) = db {

                        if let Ok(conn) = db.lock() {

                            let _ = store_file_key(&conn, &rec.id, &key_b64);

                            if let Some(folder_id) = prepared.folder_id.as_deref() {

                                if existing_key.is_none() {

                                    let _ =

                                        delete_pending_file_key(&conn, folder_id, &prepared.name);

                                }

                            }

                        }

                    }

                    if let Some(auth) = crate::auth_store::load_auth().ok().flatten() {
                        if let Ok(user) =
                            serde_json::from_str::<serde_json::Value>(&auth.user_json)
                        {
                            if let Some(uid) = user.get("id").and_then(|v| v.as_str()) {
                                if let Some(db_ref) = db.as_ref() {
                                    let pushed = crate::account_crypto::push_file_key_or_queue(
                                        self,
                                        db_ref,
                                        uid,
                                        &rec.id,
                                        &key_b64,
                                    )
                                    .await
                                    .unwrap_or(false);
                                    if !pushed {
                                        eprintln!(
                                            "encryption key queued for {} — unlock encryption so web can open this file",
                                            prepared.name
                                        );
                                    }
                                }
                            }
                        }
                    }

                    crate::sync::log::sync_log(format!("http ok {}", prepared.name));

                    return Ok((rec, prepared.key));

                }

                Err(e) => {

                    let msg = e.to_string();

                    if !auth_retry && msg.contains("session expired") {

                        if self.try_refresh().await? {

                            auth_retry = true;

                            continue;

                        }

                    }

                    if rl_retries > 0 && msg.contains("rate limit") {

                        rl_retries -= 1;

                        tokio::time::sleep(Duration::from_millis(400)).await;

                        continue;

                    }

                    if transient_retries > 0 && is_transient_http_error(&msg) {
                        let attempt = (3 - transient_retries) as usize;
                        let delay = backoff_ms[attempt.min(backoff_ms.len() - 1)];
                        transient_retries -= 1;
                        tokio::time::sleep(Duration::from_millis(delay)).await;
                        continue;
                    }

                    if let (Some(db), Some(folder_id)) = (db, prepared.folder_id.as_deref()) {

                        if existing_key.is_none() {

                            if let Ok(conn) = db.lock() {

                                let _ = delete_pending_file_key(&conn, folder_id, &prepared.name);

                            }

                        }

                    }

                    return Err(e);

                }

            }

        }

    }



    pub async fn download_file(
        &self,
        file_id: &str,
        key_b64url: Option<&str>,
    ) -> AppResult<Vec<u8>> {
        let tmp = crate::auth_store::data_dir()?
            .join("tmp")
            .join(format!("dl_{}.bin", uuid::Uuid::new_v4()));
        if let Some(parent) = tmp.parent() {
            std::fs::create_dir_all(parent)?;
        }
        self.download_file_to_path(file_id, key_b64url, &tmp).await?;
        let bytes = tokio::fs::read(&tmp).await?;
        let _ = tokio::fs::remove_file(&tmp).await;
        Ok(bytes)
    }

    /// Download and decrypt a bounded preview without writing plaintext to disk.
    pub async fn download_file_for_preview(
        &self,
        file_id: &str,
        key_b64url: &str,
        max_plaintext_bytes: usize,
    ) -> AppResult<Vec<u8>> {
        use futures_util::StreamExt;

        let url = self.api_url(&format!("/files/{}/download", file_id));
        let mut auth_retried = false;
        loop {
            let (access_token, http) = {
                let inner = self.inner.read();
                (inner.access_token.clone(), inner.http.clone())
            };
            let res = http
                .get(&url)
                .header("Authorization", format!("Bearer {}", access_token))
                .send()
                .await
                .map_err(|e| AppError::msg(format!("preview download failed: {e}")))?;
            if res.status() == reqwest::StatusCode::UNAUTHORIZED && !auth_retried {
                auth_retried = true;
                if self.try_refresh().await? {
                    continue;
                }
            }
            if !res.status().is_success() {
                let status = res.status();
                let text = res.text().await.unwrap_or_default();
                return Err(http_api_error(status, &text));
            }
            let iv_header = res
                .headers()
                .get("x-file-iv")
                .and_then(|value| value.to_str().ok())
                .unwrap_or("")
                .to_owned();
            let transfer_limit = max_plaintext_bytes.saturating_add(1024 * 1024);
            if res.content_length().is_some_and(|length| length > transfer_limit as u64) {
                return Err(AppError::msg("file exceeds the desktop preview limit"));
            }
            let mut ciphertext = Vec::new();
            let mut stream = res.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|e| AppError::msg(format!("preview download interrupted: {e}")))?;
                if ciphertext.len().saturating_add(chunk.len()) > transfer_limit {
                    return Err(AppError::msg("file exceeds the desktop preview limit"));
                }
                ciphertext.extend_from_slice(&chunk);
            }
            let plaintext = if iv_header.is_empty() {
                ciphertext
            } else {
                let key = crypto::key_from_b64url(key_b64url)?;
                let iv = crypto::iv_from_base64(&iv_header)?;
                crypto::decrypt_file(&ciphertext, &key, &iv)?
            };
            if plaintext.len() > max_plaintext_bytes {
                return Err(AppError::msg("file exceeds the desktop preview limit"));
            }
            return Ok(plaintext);
        }
    }

    /// Lightweight check that the encrypted blob is readable on the server.
    /// Does not download the body — drops the response after status/headers.
    /// Returns `Ok(true)` when readable, `Ok(false)` when blob is missing/unreadable.
    pub async fn probe_file_download(&self, file_id: &str) -> AppResult<bool> {
        let url = self.api_url(&format!("/files/{}/download", file_id));
        let (access_token, http) = {
            let inner = self.inner.read();
            (inner.access_token.clone(), inner.http.clone())
        };
        let res = http
            .get(&url)
            .header("Authorization", format!("Bearer {}", access_token))
            .send()
            .await
            .map_err(|e| AppError::msg(format!("download connect failed: {e}")))?;

        if res.status() == reqwest::StatusCode::UNAUTHORIZED {
            if self.try_refresh().await? {
                // One retry after refresh.
                let (access_token, http) = {
                    let inner = self.inner.read();
                    (inner.access_token.clone(), inner.http.clone())
                };
                let res = http
                    .get(&url)
                    .header("Authorization", format!("Bearer {}", access_token))
                    .send()
                    .await
                    .map_err(|e| AppError::msg(format!("download connect failed: {e}")))?;
                return classify_probe_response(res).await;
            }
            return Err(AppError::msg("session expired"));
        }

        classify_probe_response(res).await
    }

    /// Download ciphertext to disk (streamed), decrypt, write plaintext to `dest`.
    /// Avoids buffering the whole HTTP body as a second in-memory copy during transfer.
    pub async fn download_file_to_path(
        &self,
        file_id: &str,
        key_b64url: Option<&str>,
        dest: &Path,
    ) -> AppResult<()> {
        let mut auth_retry = false;
        let mut rl_retries = 2u32;
        let mut transient_retries = 3u32;
        let backoff_ms = [200u64, 500, 1000];

        loop {
            match self
                .download_file_to_path_once(file_id, key_b64url, dest)
                .await
            {
                Ok(()) => return Ok(()),
                Err(e) => {
                    let msg = e.to_string();
                    if !auth_retry && msg.contains("session expired") {
                        if self.try_refresh().await? {
                            auth_retry = true;
                            continue;
                        }
                    }
                    if rl_retries > 0 && msg.contains("rate limit") {
                        rl_retries -= 1;
                        tokio::time::sleep(Duration::from_millis(400)).await;
                        continue;
                    }
                    if transient_retries > 0 && is_transient_http_error(&msg) {
                        let attempt = (3 - transient_retries) as usize;
                        let delay = backoff_ms[attempt.min(backoff_ms.len() - 1)];
                        transient_retries -= 1;
                        tokio::time::sleep(Duration::from_millis(delay)).await;
                        continue;
                    }
                    return Err(e);
                }
            }
        }
    }

    async fn download_file_to_path_once(
        &self,
        file_id: &str,
        key_b64url: Option<&str>,
        dest: &Path,
    ) -> AppResult<()> {
        use futures_util::StreamExt;
        use tokio::io::AsyncWriteExt;

        let url = self.api_url(&format!("/files/{}/download", file_id));
        let (access_token, http) = {
            let inner = self.inner.read();
            (inner.access_token.clone(), inner.http.clone())
        };
        let res = http
            .get(&url)
            .header("Authorization", format!("Bearer {}", access_token))
            .send()
            .await
            .map_err(|e| AppError::msg(format!("download connect failed: {e}")))?;

        if res.status() == reqwest::StatusCode::UNAUTHORIZED {
            if self.try_refresh().await? {
                return Err(AppError::msg("session expired"));
            }
            return Err(AppError::msg("session expired"));
        }

        if res.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
            return Err(AppError::msg("rate limit exceeded"));
        }

        if !res.status().is_success() {
            let status = res.status();
            let text = res.text().await.unwrap_or_default();
            return Err(http_api_error(status, &text));
        }

        let iv_header = res
            .headers()
            .get("x-file-iv")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();

        if let Some(parent) = dest.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        let enc_path = dest.with_extension("enc.tmp");
        let _ = tokio::fs::remove_file(&enc_path).await;
        let _ = tokio::fs::remove_file(dest).await;

        {
            let mut file = tokio::fs::File::create(&enc_path).await?;
            let mut stream = res.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let started = std::time::Instant::now();
                let chunk = chunk
                    .map_err(|e| AppError::msg(format!("download interrupted: {e}")))?;
                file.write_all(&chunk).await?;
                let limit = self.inner.read().download_limit_bps;
                if limit > 0 {
                    let target = Duration::from_secs_f64(chunk.len() as f64 / limit as f64);
                    if let Some(delay) = target.checked_sub(started.elapsed()) {
                        tokio::time::sleep(delay).await;
                    }
                }
            }
            file.flush().await?;
        }

        let result = async {
            if iv_header.is_empty() {
                tokio::fs::rename(&enc_path, dest).await?;
                return Ok(());
            }

            let key_b64url =
                key_b64url.ok_or_else(|| AppError::msg("missing encryption key"))?;
            let key = crypto::key_from_b64url(key_b64url)?;
            let iv = crypto::iv_from_base64(&iv_header)?;
            let ciphertext = tokio::fs::read(&enc_path).await?;
            let plaintext = crypto::decrypt_file(&ciphertext, &key, &iv)?;
            drop(ciphertext);
            tokio::fs::write(dest, &plaintext).await?;
            drop(plaintext);
            Ok::<(), AppError>(())
        }
        .await;

        let _ = tokio::fs::remove_file(&enc_path).await;
        result
    }

    async fn resumable_stream_once(
        &self,
        prepared: &PreparedUpload,
        replace_file_id: Option<&str>,
        timeout: Duration,
        on_progress: Option<&UploadProgressCb>,
    ) -> AppResult<crate::api::types::FileRecord> {
        use std::io::{Read, Seek, SeekFrom};

        let cipher_len = match &prepared.body {
            UploadBody::Memory(v) => v.len() as u64,
            UploadBody::TempFile(p) => std::fs::metadata(p)?.len(),
        };

        report_progress(on_progress, 0, cipher_len);

        let mut session_body = serde_json::json!({
            "name": prepared.name,
            "mime_type": prepared.mime,
            "iv": prepared.iv_b64,
            "original_size": prepared.original_size,
            "encrypted_size": cipher_len,
        });
        if let Some(fid) = &prepared.folder_id {
            session_body["folder_id"] = serde_json::Value::String(fid.clone());
        }
        if let Some(fid) = replace_file_id {
            session_body["file_id"] = serde_json::Value::String(fid.to_string());
        }

        #[derive(serde::Deserialize)]
        struct SessionResp {
            id: String,
        }
        let session: SessionResp = self
            .request_json(
                reqwest::Method::POST,
                "/uploads/sessions",
                Some(session_body),
                false,
                2,
            )
            .await?;

        let mut offset: u64 = 0;
        while offset < cipher_len {
            let limit = self.inner.read().upload_limit_bps;
            let rate_chunk = if limit > 0 {
                (limit / 4).clamp(64 * 1024, RESUMABLE_CHUNK as u64)
            } else {
                RESUMABLE_CHUNK as u64
            };
            let end = std::cmp::min(offset + rate_chunk, cipher_len) - 1;
            let chunk_len = (end - offset + 1) as usize;
            let chunk = match &prepared.body {
                UploadBody::Memory(v) => v[offset as usize..=end as usize].to_vec(),
                UploadBody::TempFile(p) => {
                    let mut f = std::fs::File::open(p)?;
                    f.seek(SeekFrom::Start(offset))?;
                    let mut buf = vec![0u8; chunk_len];
                    f.read_exact(&mut buf)?;
                    buf
                }
            };
            let range = format!("bytes {}-{}/{}", offset, end, cipher_len);
            let url = self.api_url(&format!("/uploads/sessions/{}", session.id));
            let access_token = self.inner.read().access_token.clone();
            let http = self.inner.read().upload_http.clone();
            let started = std::time::Instant::now();
            let res = http
                .put(&url)
                .header("Authorization", format!("Bearer {}", access_token))
                .header("Content-Range", &range)
                .header("Content-Type", "application/octet-stream")
                .timeout(timeout)
                .body(chunk)
                .send()
                .await?;

            if limit > 0 {
                let target = Duration::from_secs_f64(chunk_len as f64 / limit as f64);
                if let Some(delay) = target.checked_sub(started.elapsed()) {
                    tokio::time::sleep(delay).await;
                }
            }

            if res.status() == reqwest::StatusCode::UNAUTHORIZED {
                let _ = self.try_refresh().await?;
                return Err(AppError::msg("session expired"));
            }
            if res.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
                return Err(AppError::msg("rate limit exceeded"));
            }
            let status = res.status();
            let text = res.text().await.unwrap_or_default();
            if !status.is_success() {
                if let Ok(err) = serde_json::from_str::<ApiError>(&text) {
                    return Err(AppError::msg(format!("{} ({})", err.error, status)));
                }
                return Err(AppError::msg(format!("HTTP {}: {}", status, text)));
            }

            offset = end + 1;
            report_progress(on_progress, offset, cipher_len);
            if offset >= cipher_len {
                return serde_json::from_str(&text)
                    .map_err(|e| AppError::msg(format!("parse file response: {e}")));
            }
        }
        Err(AppError::msg("resumable upload incomplete"))
    }

    async fn multipart_stream_once<T: serde::de::DeserializeOwned>(

        &self,

        path: &str,

        prepared: &PreparedUpload,

        timeout: Duration,

        on_progress: Option<&UploadProgressCb>,

    ) -> AppResult<T> {

        let cipher_len = match &prepared.body {
            UploadBody::Memory(v) => v.len() as u64,
            UploadBody::TempFile(p) => std::fs::metadata(p).map(|m| m.len()).unwrap_or(0),
        };
        report_progress(on_progress, 0, cipher_len);

        let url = self.api_url(path);

        let access_token = self.inner.read().access_token.clone();

        let http = self.inner.read().upload_http.clone();



        let part = match &prepared.body {
            UploadBody::TempFile(temp_path) => {
                let file = tokio::fs::File::open(temp_path).await?;
                Part::stream(file)
                    .file_name(prepared.name.clone())
                    .mime_str(&prepared.mime)
                    .map_err(|e| AppError::msg(e.to_string()))?
            }
            UploadBody::Memory(bytes) => Part::bytes(bytes.clone())
                .file_name(prepared.name.clone())
                .mime_str(&prepared.mime)
                .map_err(|e| AppError::msg(e.to_string()))?,
        };



        let mut form = Form::new()

            .part("file", part)

            .text("name", prepared.name.clone())

            .text("mime_type", prepared.mime.clone())

            .text("iv", prepared.iv_b64.clone())

            .text("original_size", prepared.original_size.to_string());



        if let Some(fid) = &prepared.folder_id {

            form = form.text("folder_id", fid.clone());

        }



        let res = http

            .post(&url)

            .header("Authorization", format!("Bearer {}", access_token))

            .multipart(form)

            .timeout(timeout)

            .send()

            .await?;



        if res.status() == reqwest::StatusCode::UNAUTHORIZED {

            if self.try_refresh().await? {

                return Err(AppError::msg("session expired"));

            }

            return Err(AppError::msg("session expired"));

        }



        if res.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {

            return Err(AppError::msg("rate limit exceeded"));

        }



        let status = res.status();

        let text = res.text().await?;

        if !status.is_success() {

            if let Ok(err) = serde_json::from_str::<ApiError>(&text) {

                return Err(AppError::msg(err.error));

            }

            return Err(AppError::msg(format!("upload failed ({})", status)));

        }

        report_progress(on_progress, cipher_len, cipher_len);

        serde_json::from_str(&text).map_err(Into::into)

    }

    pub async fn get_crypto_account(
        &self,
    ) -> AppResult<serde_json::Value> {
        self.request_json(reqwest::Method::GET, "/crypto/account", None, false, 2)
            .await
    }

    pub async fn setup_crypto_account(
        &self,
        key_salt: &[u8],
        wrapped_uek: &str,
        wrapped_uek_recovery: Option<&str>,
    ) -> AppResult<()> {
        let mut body = serde_json::json!({
            "key_salt": key_salt,
            "wrapped_uek": wrapped_uek,
        });
        if let Some(recovery) = wrapped_uek_recovery {
            body["wrapped_uek_recovery"] = serde_json::Value::String(recovery.to_string());
        }
        let _: serde_json::Value = self
            .request_json(reqwest::Method::POST, "/crypto/account", Some(body), false, 2)
            .await?;
        Ok(())
    }

    pub async fn update_crypto_account(
        &self,
        key_salt: &[u8],
        wrapped_uek: &str,
        wrapped_uek_recovery: Option<&str>,
    ) -> AppResult<()> {
        let mut body = serde_json::json!({
            "key_salt": key_salt,
            "wrapped_uek": wrapped_uek,
        });
        if let Some(recovery) = wrapped_uek_recovery {
            body["wrapped_uek_recovery"] = serde_json::Value::String(recovery.to_string());
        }
        let _: serde_json::Value = self
            .request_json(reqwest::Method::PUT, "/crypto/account", Some(body), false, 2)
            .await?;
        Ok(())
    }

    pub async fn list_encryption_keys(
        &self,
        since: &str,
    ) -> AppResult<serde_json::Value> {
        let path = if since.is_empty() {
            "/encryption-keys".to_string()
        } else {
            format!("/encryption-keys?since={}", urlencoding::encode(since))
        };
        self.request_json(reqwest::Method::GET, &path, None, false, 2)
            .await
    }

    pub async fn bulk_put_encryption_keys(
        &self,
        keys: std::collections::HashMap<String, String>,
    ) -> AppResult<serde_json::Value> {
        self.request_json(
            reqwest::Method::POST,
            "/encryption-keys/bulk",
            Some(serde_json::json!({ "keys": keys })),
            false,
            2,
        )
        .await
    }

    pub async fn get_file_encryption_key(
        &self,
        file_id: &str,
    ) -> AppResult<serde_json::Value> {
        self.request_json(
            reqwest::Method::GET,
            &format!("/files/{}/encryption-key", file_id),
            None,
            false,
            2,
        )
        .await
    }

    pub async fn put_file_encryption_key(
        &self,
        file_id: &str,
        wrapped_file_key: &str,
    ) -> AppResult<()> {
        let _: serde_json::Value = self
            .request_json(
                reqwest::Method::PUT,
                &format!("/files/{}/encryption-key", file_id),
                Some(serde_json::json!({ "wrapped_file_key": wrapped_file_key })),
                false,
                2,
            )
            .await?;
        Ok(())
    }

}



#[allow(dead_code)]
pub fn file_key_b64url(key: &[u8; 32]) -> String {
    key_to_b64url(key)
}
