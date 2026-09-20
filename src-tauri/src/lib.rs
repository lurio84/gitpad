mod git;

use std::path::Path;

use git::error::GitResult;
use git::repo::{
    Branch, Commit, CommitFile, FileContent, LogFilter, OpState, RepoInfo, Stash, Status,
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
) -> GitResult<Vec<Commit>> {
    let query = filter_query.trim();
    let filter = match (filter_mode.as_str(), query) {
        (_, "") => LogFilter::None,
        ("message", q) => LogFilter::Message(q.to_string()),
        ("content", q) => LogFilter::Content(q.to_string()),
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
fn get_tree_files(path: String, hash: String) -> GitResult<Vec<String>> {
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
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
            get_default_base
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
