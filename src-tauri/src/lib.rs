mod git;

use std::path::Path;

use git::error::GitResult;
use git::repo::{Commit, RepoInfo, Status};

// `async` sobre una fn síncrona: Tauri la ejecuta en su threadpool en vez de
// inline en el hilo del IPC, así un `git log` lento sobre un repo grande no
// congela la UI. El cuerpo sigue siendo bloqueante (no hay await).
#[tauri::command(async)]
fn open_repo(path: String) -> GitResult<RepoInfo> {
    git::repo::open(Path::new(&path))
}

#[tauri::command(async)]
fn get_log(path: String, skip: u32, count: u32) -> GitResult<Vec<Commit>> {
    git::repo::log(Path::new(&path), skip, count)
}

#[tauri::command(async)]
fn get_status(path: String) -> GitResult<Status> {
    git::repo::status(Path::new(&path))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![open_repo, get_log, get_status])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
