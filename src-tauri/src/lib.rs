mod crashlog;
mod git;

use std::path::Path;
#[cfg(windows)]
use tauri::Manager;

use git::error::GitResult;
use git::repo::{
    Branch, Commit, CommitFile, FileContent, LogFilter, OpState, RepoInfo, Stash, Status, Tag,
    TreeFiles,
};

// `async` sobre una fn síncrona: Tauri la ejecuta en su threadpool en vez de
// inline en el hilo del IPC, así un `git log` lento sobre un repo grande no
// congela la UI. El cuerpo sigue siendo bloqueante (no hay await).
#[tauri::command(async)]
fn open_repo(path: String) -> GitResult<RepoInfo> {
    git::repo::open(Path::new(&path))
}

#[tauri::command(async)]
fn get_log(
    path: String,
    skip: u32,
    count: u32,
    filter_mode: String,
    filter_query: String,
    filter_branch: Option<String>,
    filter_file: Option<String>,
) -> GitResult<Vec<Commit>> {
    let query = filter_query.trim();
    let filter = match (filter_file, filter_mode.as_str(), query) {
        // El lente de archivo manda: se cambia de lente en el frontend, no se combina.
        (Some(f), _, _) => LogFilter::File(f),
        (None, _, "") => LogFilter::None,
        (None, "message", q) => LogFilter::Message(q.to_string()),
        (None, "content", q) => LogFilter::Content(q.to_string()),
        _ => LogFilter::None,
    };
    git::repo::log(Path::new(&path), skip, count, &filter, filter_branch.as_deref())
}

#[tauri::command(async)]
fn get_branches(path: String) -> GitResult<Vec<Branch>> {
    git::repo::branches(Path::new(&path))
}

#[tauri::command(async)]
fn checkout_branch(path: String, name: String) -> GitResult<()> {
    git::repo::checkout(Path::new(&path), &name)
}

#[tauri::command(async)]
fn fetch_remote(path: String) -> GitResult<()> {
    git::repo::fetch(Path::new(&path))
}

#[tauri::command(async)]
fn pull_remote(path: String) -> GitResult<()> {
    git::repo::pull(Path::new(&path))
}

#[tauri::command(async)]
fn push_remote(path: String) -> GitResult<()> {
    git::repo::push(Path::new(&path))
}

#[tauri::command(async)]
fn fetch_branch(path: String, branch: String, remote: String, remote_ref: String) -> GitResult<()> {
    git::repo::fetch_branch(Path::new(&path), &branch, &remote, &remote_ref)
}

#[tauri::command(async)]
fn push_branch(path: String, branch: String, remote: String, remote_ref: String) -> GitResult<()> {
    git::repo::push_branch(Path::new(&path), &branch, &remote, &remote_ref)
}

#[tauri::command(async)]
fn push_new_branch(path: String, branch: String) -> GitResult<()> {
    git::repo::push_new_branch(Path::new(&path), &branch)
}

#[tauri::command(async)]
fn push_tag_remote(path: String, name: String) -> GitResult<()> {
    git::repo::push_tag(Path::new(&path), &name)
}

#[tauri::command(async)]
fn delete_remote_tag(path: String, name: String) -> GitResult<()> {
    git::repo::delete_remote_tag(Path::new(&path), &name)
}

#[tauri::command(async)]
fn get_op_state(path: String) -> GitResult<Option<OpState>> {
    git::repo::op_state(Path::new(&path))
}

#[tauri::command(async)]
fn op_continue(path: String) -> GitResult<()> {
    git::repo::op_continue(Path::new(&path))
}

#[tauri::command(async)]
fn op_abort(path: String) -> GitResult<()> {
    git::repo::op_abort(Path::new(&path))
}

#[tauri::command(async)]
fn stash_push(path: String, message: String, include_untracked: bool) -> GitResult<()> {
    git::repo::stash_push(Path::new(&path), &message, include_untracked)
}

#[tauri::command(async)]
fn get_stashes(path: String) -> GitResult<Vec<Stash>> {
    git::repo::stash_list(Path::new(&path))
}

#[tauri::command(async)]
fn stash_apply(path: String, index: u32, pop: bool) -> GitResult<()> {
    git::repo::stash_apply(Path::new(&path), index, pop)
}

#[tauri::command(async)]
fn stash_drop(path: String, index: u32) -> GitResult<()> {
    git::repo::stash_drop(Path::new(&path), index)
}

#[tauri::command(async)]
fn cherry_pick(path: String, hash: String) -> GitResult<()> {
    git::repo::cherry_pick(Path::new(&path), &hash)
}

#[tauri::command(async)]
fn rebase_onto(path: String, onto: String) -> GitResult<()> {
    git::repo::rebase(Path::new(&path), &onto)
}

#[tauri::command(async)]
fn merge_branch(path: String, from: String) -> GitResult<()> {
    git::repo::merge(Path::new(&path), &from)
}

#[tauri::command(async)]
fn revert_commit(path: String, hash: String) -> GitResult<()> {
    git::repo::revert(Path::new(&path), &hash)
}

#[tauri::command(async)]
fn reset_to(path: String, hash: String, mode: String) -> GitResult<()> {
    git::repo::reset(Path::new(&path), &hash, &mode)
}

#[tauri::command(async)]
fn create_branch(path: String, name: String, at: Option<String>) -> GitResult<()> {
    git::repo::create_branch(Path::new(&path), &name, at.as_deref())
}

#[tauri::command(async)]
fn rename_branch(path: String, old: String, new: String) -> GitResult<()> {
    git::repo::rename_branch(Path::new(&path), &old, &new)
}

#[tauri::command(async)]
fn delete_branch(path: String, name: String, force: bool) -> GitResult<()> {
    git::repo::delete_branch(Path::new(&path), &name, force)
}

#[tauri::command(async)]
fn create_tag(path: String, name: String, at: Option<String>) -> GitResult<()> {
    git::repo::create_tag(Path::new(&path), &name, at.as_deref())
}

#[tauri::command(async)]
fn delete_tag(path: String, name: String) -> GitResult<()> {
    git::repo::delete_tag(Path::new(&path), &name)
}

#[tauri::command(async)]
fn get_tags(path: String) -> GitResult<Vec<Tag>> {
    git::repo::list_tags(Path::new(&path))
}

#[tauri::command(async)]
fn get_default_base(path: String) -> GitResult<Option<String>> {
    git::repo::default_base(Path::new(&path))
}

#[tauri::command(async)]
fn get_status(path: String) -> GitResult<Status> {
    git::repo::status(Path::new(&path))
}

#[tauri::command(async)]
fn get_commit_diff(path: String, hash: String) -> GitResult<String> {
    git::repo::commit_diff(Path::new(&path), &hash)
}

#[tauri::command(async)]
fn get_file_diff(path: String, file: String, staged: bool) -> GitResult<String> {
    git::repo::file_diff(Path::new(&path), &file, staged)
}

#[tauri::command(async)]
fn get_commit_files(path: String, hash: String) -> GitResult<Vec<CommitFile>> {
    git::repo::commit_files(Path::new(&path), &hash)
}

#[tauri::command(async)]
fn get_commit_file_diff(
    path: String,
    hash: String,
    file: String,
    orig_path: Option<String>,
) -> GitResult<String> {
    git::repo::commit_file_diff(Path::new(&path), &hash, &file, orig_path.as_deref())
}

#[tauri::command(async)]
fn get_tree_files(path: String, hash: String) -> GitResult<TreeFiles> {
    git::repo::tree_files(Path::new(&path), &hash)
}

#[tauri::command(async)]
fn get_file_content(path: String, hash: String, file: String) -> GitResult<FileContent> {
    git::repo::file_content(Path::new(&path), &hash, &file)
}

#[tauri::command(async)]
fn stage_paths(path: String, paths: Vec<String>) -> GitResult<()> {
    git::repo::stage(Path::new(&path), &paths)
}

#[tauri::command(async)]
fn unstage_paths(path: String, paths: Vec<String>) -> GitResult<()> {
    git::repo::unstage(Path::new(&path), &paths)
}

#[tauri::command(async)]
fn discard_paths(
    path: String,
    paths: Vec<String>,
    orig_paths: Vec<String>,
    untracked: bool,
) -> GitResult<()> {
    git::repo::discard(Path::new(&path), &paths, &orig_paths, untracked)
}

#[tauri::command(async)]
fn commit(path: String, message: String, amend: bool) -> GitResult<String> {
    git::repo::commit(Path::new(&path), &message, amend)
}

// La ventana solo recibía un HICON de 16px (el que WebView2/tao pone por
// defecto), así que Windows lo estiraba para la barra de tareas y Alt+Tab.
// El .exe ya lleva incrustados todos los tamaños de icon.ico vía build.rs;
// esto solo pide los tamaños que Windows usa para ICON_BIG/ICON_SMALL
// (habitualmente 32/16px) y se los asigna explícitos a la ventana.
#[cfg(windows)]
fn set_window_icons(window: &tauri::WebviewWindow) {
    use windows::core::HSTRING;
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::UI::Shell::ExtractIconExW;
    use windows::Win32::UI::WindowsAndMessaging::{
        SendMessageW, HICON, ICON_BIG, ICON_SMALL, WM_SETICON,
    };

    let Ok(hwnd) = window.hwnd() else { return };
    let Ok(exe) = std::env::current_exe() else { return };
    let path = HSTRING::from(exe.to_string_lossy().as_ref());

    let mut large = HICON::default();
    let mut small = HICON::default();
    let extracted = unsafe { ExtractIconExW(&path, 0, Some(&mut large), Some(&mut small), 1) };
    if extracted == 0 {
        return;
    }

    unsafe {
        if !large.is_invalid() {
            SendMessageW(
                hwnd,
                WM_SETICON,
                Some(WPARAM(ICON_BIG as usize)),
                Some(LPARAM(large.0 as isize)),
            );
        }
        if !small.is_invalid() {
            SendMessageW(
                hwnd,
                WM_SETICON,
                Some(WPARAM(ICON_SMALL as usize)),
                Some(LPARAM(small.0 as isize)),
            );
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if let Some(dir) = crashlog::default_dir() {
        crashlog::install(dir);
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|_app| {
            #[cfg(windows)]
            if let Some(window) = _app.get_webview_window("main") {
                set_window_icons(&window);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_repo,
            get_log,
            get_status,
            get_commit_diff,
            get_file_diff,
            get_commit_files,
            get_commit_file_diff,
            get_tree_files,
            get_file_content,
            stage_paths,
            unstage_paths,
            discard_paths,
            commit,
            get_branches,
            checkout_branch,
            fetch_remote,
            pull_remote,
            push_remote,
            get_op_state,
            op_continue,
            op_abort,
            stash_push,
            get_stashes,
            stash_apply,
            stash_drop,
            cherry_pick,
            rebase_onto,
            merge_branch,
            revert_commit,
            reset_to,
            create_branch,
            rename_branch,
            delete_branch,
            create_tag,
            delete_tag,
            get_tags,
            fetch_branch,
            push_branch,
            push_new_branch,
            push_tag_remote,
            delete_remote_tag,
            get_default_base
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
