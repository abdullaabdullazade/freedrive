use crate::api::client::ApiClient;
use crate::db::{get_sync_cursor, set_sync_cursor, DbHandle};
use crate::error::{AppError, AppResult};
use crate::sync::apply::{apply_remote_change, apply_snapshot};
use crate::sync::engine::SyncEngine;
use crate::sync::journal::drain_journal;
use crate::sync::log::sync_log;
use crate::sync::suppress::WatcherSuppress;

pub async fn run_sync_cycle(
    engine: &SyncEngine,
    api: &ApiClient,
    db: &DbHandle,
    suppress: &WatcherSuppress,
    computer_id: &str,
    computer_root_id: &str,
) -> AppResult<()> {
    let journal_count = drain_journal(engine, api, db).await?;
    if journal_count > 0 {
        sync_log(format!("journal drained — {} entries", journal_count));
    }

    let cursor = {
        let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
        get_sync_cursor(&conn, computer_id)?
    };

    if cursor == 0 {
        let snapshot = api.get_computer_snapshot(computer_id).await?;
        apply_snapshot(engine, api, db, suppress, computer_root_id, &snapshot).await?;
        let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
        set_sync_cursor(&conn, computer_id, snapshot.cursor)?;
        sync_log(format!("initial snapshot applied — cursor {}", snapshot.cursor));
        return Ok(());
    }

    let page = api.get_computer_changes(computer_id, cursor, 200).await?;
    if page.changes.is_empty() {
        return Ok(());
    }

    for change in &page.changes {
        if let Err(e) = apply_remote_change(
            engine,
            api,
            db,
            suppress,
            computer_root_id,
            change,
        )
        .await
        {
            sync_log(format!(
                "apply change seq={} {} {} failed: {}",
                change.seq, change.operation, change.entity_id, e
            ));
            // Continue — a single failure must not stall the cursor forever.
        }
    }

    let conn = db.lock().map_err(|e| AppError::msg(e.to_string()))?;
    set_sync_cursor(&conn, computer_id, page.next_cursor)?;
    sync_log(format!(
        "changes applied — cursor {} -> {}",
        cursor, page.next_cursor
    ));
    Ok(())
}
