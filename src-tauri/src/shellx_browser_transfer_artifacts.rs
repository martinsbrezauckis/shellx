use std::io::Read;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::shellx_browser::clean_string;
use crate::shellx_browser_transfer_privacy::browser_download_destination_dir;

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserLocalTextArtifactRequest {
    #[serde(rename = "destinationDir", alias = "destination_dir", default)]
    pub destination_dir: Option<String>,
    #[serde(rename = "fileName", alias = "file_name", default)]
    pub file_name: Option<String>,
    pub content: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserLocalFileArtifactRequest {
    #[serde(rename = "sourcePath", alias = "source_path")]
    pub source_path: String,
    #[serde(rename = "destinationDir", alias = "destination_dir", default)]
    pub destination_dir: Option<String>,
    #[serde(rename = "fileName", alias = "file_name", default)]
    pub file_name: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserLocalArtifact {
    #[serde(rename = "finalPath")]
    pub final_path: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    #[serde(rename = "mimeType", skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    pub bytes: u64,
    pub sha256: String,
}

#[tauri::command]
pub fn shellx_browser_write_text_artifact(
    request: BrowserLocalTextArtifactRequest,
) -> Result<BrowserLocalArtifact, String> {
    let content = request.content;
    let file_name = sanitized_download_file_name(request.file_name.as_deref(), "shellx-page.md");
    let destination_dir = browser_download_destination_dir(request.destination_dir.as_deref())?;
    std::fs::create_dir_all(&destination_dir)
        .map_err(|e| format!("create {} failed: {}", destination_dir.display(), e))?;
    let path = unique_destination_path(&destination_dir, &file_name);
    std::fs::write(&path, content.as_bytes())
        .map_err(|e| format!("write {} failed: {}", path.display(), e))?;
    let (bytes, sha256) = file_artifact_metadata(&path.to_string_lossy())?
        .ok_or_else(|| "written browser artifact is empty".to_string())?;
    Ok(BrowserLocalArtifact {
        final_path: path.to_string_lossy().into_owned(),
        display_name: path
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or(file_name),
        mime_type: infer_mime_type_from_path(&path.to_string_lossy()),
        bytes,
        sha256,
    })
}

#[tauri::command]
pub fn shellx_browser_copy_local_artifact(
    request: BrowserLocalFileArtifactRequest,
) -> Result<BrowserLocalArtifact, String> {
    let source = std::path::PathBuf::from(clean_string(request.source_path));
    if source.as_os_str().is_empty() {
        return Err("sourcePath is required".to_string());
    }
    if !source.is_file() {
        return Err(format!(
            "source artifact is not a file: {}",
            source.display()
        ));
    }
    let source = source
        .canonicalize()
        .map_err(|e| format!("resolve source artifact {} failed: {}", source.display(), e))?;
    ensure_browser_local_artifact_source_allowed(&source)?;
    let fallback_name = source
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "shellx-page-artifact".to_string());
    let file_name = sanitized_download_file_name(request.file_name.as_deref(), &fallback_name);
    let destination_dir = browser_download_destination_dir(request.destination_dir.as_deref())?;
    std::fs::create_dir_all(&destination_dir)
        .map_err(|e| format!("create {} failed: {}", destination_dir.display(), e))?;
    let path = unique_destination_path(&destination_dir, &file_name);
    std::fs::copy(&source, &path).map_err(|e| {
        format!(
            "copy {} to {} failed: {}",
            source.display(),
            path.display(),
            e
        )
    })?;
    let (bytes, sha256) = file_artifact_metadata(&path.to_string_lossy())?
        .ok_or_else(|| "copied browser artifact is empty".to_string())?;
    Ok(BrowserLocalArtifact {
        final_path: path.to_string_lossy().into_owned(),
        display_name: path
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or(file_name),
        mime_type: infer_mime_type_from_path(&path.to_string_lossy()),
        bytes,
        sha256,
    })
}

fn sanitized_download_file_name(value: Option<&str>, fallback: &str) -> String {
    let raw = value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback);
    let mut out = String::new();
    for ch in raw.chars() {
        if ch.is_ascii_control()
            || matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
        {
            out.push('-');
        } else {
            out.push(ch);
        }
        if out.len() >= 160 {
            break;
        }
    }
    let trimmed = out.trim().trim_matches('.').trim().to_string();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed
    }
}

fn unique_destination_path(dir: &std::path::Path, file_name: &str) -> std::path::PathBuf {
    let original = std::path::Path::new(file_name);
    let stem = original
        .file_stem()
        .map(|value| value.to_string_lossy().into_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "shellx-page-artifact".to_string());
    let ext = original
        .extension()
        .map(|value| value.to_string_lossy().into_owned())
        .filter(|value| !value.is_empty());
    let mut candidate = dir.join(file_name);
    for index in 1..10_000 {
        if !candidate.exists() {
            return candidate;
        }
        let next_name = match ext.as_deref() {
            Some(ext) => format!("{}-{}.{}", stem, index, ext),
            None => format!("{}-{}", stem, index),
        };
        candidate = dir.join(next_name);
    }
    candidate
}

fn ensure_browser_local_artifact_source_allowed(source: &std::path::Path) -> Result<(), String> {
    for root in browser_local_artifact_roots()? {
        let Ok(root) = root.canonicalize() else {
            continue;
        };
        if source.starts_with(&root) {
            return Ok(());
        }
    }
    Err("sourcePath must be a ShellX Browser generated artifact".to_string())
}

fn browser_local_artifact_roots() -> Result<Vec<std::path::PathBuf>, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "HOME/USERPROFILE is not set".to_string())?;
    let home = std::path::PathBuf::from(home);
    let roots = [
        home.join(".shellx").join("browser-artifacts"),
        home.join(".grok"),
    ];
    Ok(roots
        .into_iter()
        .flat_map(|root| {
            [
                "shellx-browser-screenshots",
                "shellx-browser-har",
                "shellx-browser-performance",
                "shellx-browser-traces",
                "shellx-browser-recipes",
                "shellx-browser-storage-state",
            ]
            .into_iter()
            .map(move |folder| root.join(folder))
        })
        .collect())
}

pub(crate) fn file_artifact_metadata(path: &str) -> Result<Option<(u64, String)>, String> {
    let path = std::path::PathBuf::from(path);
    let file = match std::fs::File::open(&path) {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("open {} failed: {}", path.display(), err)),
    };
    let mut reader = std::io::BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut bytes = 0u64;
    let mut buffer = vec![0u8; 64 * 1024].into_boxed_slice();
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|err| format!("read {} failed: {}", path.display(), err))?;
        if read == 0 {
            break;
        }
        bytes = bytes.saturating_add(read as u64);
        hasher.update(&buffer[..read]);
    }
    if bytes == 0 {
        return Ok(None);
    }
    Ok(Some((bytes, format!("{:x}", hasher.finalize()))))
}

pub(crate) fn infer_mime_type_from_path(path: &str) -> Option<String> {
    let ext = std::path::Path::new(path)
        .extension()
        .map(|value| value.to_string_lossy().to_ascii_lowercase())?;
    let mime = match ext.as_str() {
        "txt" | "log" | "md" => "text/plain",
        "csv" => "text/csv",
        "json" => "application/json",
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "zip" => "application/zip",
        "gz" => "application/gzip",
        "tar" => "application/x-tar",
        _ => return None,
    };
    Some(mime.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_artifact_metadata_streams_large_file_exactly() {
        let path = std::env::temp_dir().join(format!(
            "shellx-browser-artifact-metadata-{}.bin",
            uuid::Uuid::new_v4().simple()
        ));
        let body = (0..(3 * 64 * 1024 + 37))
            .map(|index| (index % 251) as u8)
            .collect::<Vec<_>>();
        std::fs::write(&path, &body).expect("write large artifact fixture");

        let metadata = file_artifact_metadata(&path.to_string_lossy())
            .expect("hash large artifact")
            .expect("large artifact metadata");
        let _ = std::fs::remove_file(&path);

        assert_eq!(metadata.0, body.len() as u64);
        assert_eq!(metadata.1, format!("{:x}", Sha256::digest(&body)));
    }
}
