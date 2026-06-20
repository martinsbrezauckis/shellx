#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LegacyImportReceipt {
    pub imported_keys: usize,
    pub skipped: bool,
    pub backup_path: Option<String>,
    pub completed_at_ms: i64,
}
