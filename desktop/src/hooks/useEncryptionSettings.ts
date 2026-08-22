import { useCallback, useState } from "react";
import { api } from "../api/tauri";

export function useEncryptionSettings() {
  const [settingsError, setSettingsError] = useState("");
  const [keysImportMessage, setKeysImportMessage] = useState("");
  const [keysImporting, setKeysImporting] = useState(false);
  const [keysExporting, setKeysExporting] = useState(false);
  const [cryptoUnlocked, setCryptoUnlocked] = useState(false);
  const [serverHasCrypto, setServerHasCrypto] = useState(false);
  const [cryptoUnlockError, setCryptoUnlockError] = useState("");
  const [needsCryptoRecovery, setNeedsCryptoRecovery] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState("");
  const [recoveryUnlocking, setRecoveryUnlocking] = useState(false);
  const [rotatePassword, setRotatePassword] = useState("");
  const [rotatingKey, setRotatingKey] = useState(false);

  const refreshCryptoStatus = useCallback(async () => {
    try {
      const status = await api.getCryptoStatus();
      setCryptoUnlocked(status.unlocked);
      setServerHasCrypto(status.server_has_crypto);
      setNeedsCryptoRecovery(status.needs_recovery);
      if (status.unlocked) {
        setCryptoUnlockError("");
      }
    } catch {
      setCryptoUnlocked(false);
      setServerHasCrypto(false);
      setNeedsCryptoRecovery(false);
    }
  }, []);

  const handleExportEncryptionKeys = async () => {
    setSettingsError("");
    setKeysImportMessage("");
    setKeysExporting(true);
    try {
      const result = await api.exportEncryptionKeys();
      setKeysImportMessage(
        `Exported ${result.exported} encryption key${result.exported === 1 ? "" : "s"} to ${result.path}.`,
      );
    } catch (err) {
      const message = String(err);
      if (!message.includes("Export cancelled")) {
        setSettingsError(message);
      }
    } finally {
      setKeysExporting(false);
    }
  };

  const handleImportEncryptionKeys = async () => {
    setSettingsError("");
    setKeysImportMessage("");
    setKeysImporting(true);
    try {
      const result = await api.importEncryptionKeys();
      setKeysImportMessage(
        `Imported ${result.imported} encryption key${result.imported === 1 ? "" : "s"}.`,
      );
    } catch (err) {
      const message = String(err);
      if (!message.includes("No file selected")) {
        setSettingsError(message);
      }
    } finally {
      setKeysImporting(false);
    }
  };

  const handleUnlockRecovery = async () => {
    setSettingsError("");
    if (!recoveryCode.trim()) {
      setSettingsError("Enter recovery code");
      return;
    }
    setRecoveryUnlocking(true);
    try {
      const stats = await api.unlockCryptoRecovery(recoveryCode.trim());
      const total = stats.pulled + stats.pushed + stats.pending_flushed;
      setKeysImportMessage(
        total > 0
          ? `Encryption restored and synced ${total} key${total === 1 ? "" : "s"}.`
          : "Encryption restored.",
      );
      setCryptoUnlocked(true);
      setNeedsCryptoRecovery(false);
      setRecoveryCode("");
    } catch (err) {
      setSettingsError(String(err));
    } finally {
      setRecoveryUnlocking(false);
    }
  };

  const handleRotateCryptoKey = async () => {
    setSettingsError("");
    if (!rotatePassword) {
      setSettingsError("Enter your password to rotate the encryption key");
      return;
    }
    setRotatingKey(true);
    try {
      const result = await api.rotateCryptoKey(rotatePassword);
      setKeysImportMessage(
        `Encryption key rotated. Save the new recovery code: ${result.recovery_code}`,
      );
      setRotatePassword("");
      setCryptoUnlocked(true);
    } catch (err) {
      setSettingsError(String(err));
    } finally {
      setRotatingKey(false);
    }
  };

  return {
    settingsError,
    setSettingsError,
    keysImportMessage,
    setKeysImportMessage,
    keysImporting,
    keysExporting,
    cryptoUnlocked,
    setCryptoUnlocked,
    serverHasCrypto,
    cryptoUnlockError,
    setCryptoUnlockError,
    needsCryptoRecovery,
    setNeedsCryptoRecovery,
    recoveryCode,
    setRecoveryCode,
    recoveryUnlocking,
    rotatePassword,
    setRotatePassword,
    rotatingKey,
    refreshCryptoStatus,
    handleExportEncryptionKeys,
    handleImportEncryptionKeys,
    handleUnlockRecovery,
    handleRotateCryptoKey,
  };
}
