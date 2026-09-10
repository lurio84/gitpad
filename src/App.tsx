import { useCallback, useEffect, useRef, useState } from "react";
import {
  getLog,
  getStatus,
  openRepo,
  pickRepoFolder,
} from "./api";
import type { Commit, GitError, RepoInfo, Status } from "./types";
import "./App.css";

const LOG_PAGE = 200;
const LAST_REPO_KEY = "gitpad:last-repo";

function isGitError(e: unknown): e is GitError {
  return typeof e === "object" && e !== null && "kind" in e && "message" in e;
}

function App() {
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Token de generación: una carga que termina tarde solo aplica su resultado
  // si sigue siendo la más reciente. Evita que un repo lento machaque a otro.
  const loadGen = useRef(0);

  const load = useCallback(async (path: string) => {
    const gen = ++loadGen.current;
    setLoading(true);
    setError(null);
    try {
      const info = await openRepo(path);
      const [log, st] = await Promise.all([
        getLog(info.root, 0, LOG_PAGE),
        getStatus(info.root),
      ]);
      if (gen !== loadGen.current) return;
      setRepo(info);
      setCommits(log);
      setStatus(st);
      localStorage.setItem(LAST_REPO_KEY, info.root);
    } catch (e) {
      if (gen !== loadGen.current) return;
      setRepo(null);
      setCommits([]);
      setStatus(null);
      setError(isGitError(e) ? e.message : String(e));
      // Un repo movido/borrado guardado en localStorage daría error en cada
      // arranque; se olvida para no dejar la app clavada en el banner rojo.
      localStorage.removeItem(LAST_REPO_KEY);
    } finally {
      if (gen === loadGen.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const last = localStorage.getItem(LAST_REPO_KEY);
    if (last) void load(last);
  }, [load]);

  const onPick = async () => {
    const path = await pickRepoFolder();
    if (path) void load(path);
  };

  const onRefresh = () => {
    if (repo) void load(repo.root);
  };

  return (
    <div className="app">
      <header className="topbar">
        <button onClick={onPick} disabled={loading}>
          Abrir repo…
        </button>
        {repo && (
          <>
            <span className="repo-name" title={repo.root}>
              {repo.root.split(/[/\\]/).pop()}
            </span>
            <span className="branch">
              {repo.head ?? "HEAD desprendido"}
            </span>
            {status && (status.ahead > 0 || status.behind > 0) && (
              <span className="ab">
                {status.ahead > 0 && `↑${status.ahead}`}
                {status.behind > 0 && ` ↓${status.behind}`}
              </span>
            )}
            <button onClick={onRefresh} disabled={loading}>
              {loading ? "…" : "Recargar"}
            </button>
          </>
        )}
      </header>

      {error && <div className="error">{error}</div>}

      {repo && (
        <div className="body">
          <section className="commits">
            <ol>
              {commits.map((c) => (
                <li key={c.hash} className="commit">
                  <div className="commit-line">
                    {c.refs.map((r) => (
                      <span key={r} className="ref">
                        {r}
                      </span>
                    ))}
                    <span className="subject">{c.subject}</span>
                  </div>
                  <div className="commit-meta">
                    <code>{c.short_hash}</code>
                    <span>{c.author_name}</span>
                    <span>{new Date(c.date).toLocaleString()}</span>
                  </div>
                </li>
              ))}
            </ol>
            {commits.length === LOG_PAGE && (
              <p className="more">
                Mostrando los primeros {LOG_PAGE} commits.
              </p>
            )}
          </section>

          <aside className="status">
            <h2>Cambios</h2>
            {status && status.entries.length === 0 && (
              <p className="clean">Árbol de trabajo limpio</p>
            )}
            <ul>
              {status?.entries.map((e) => (
                <li key={e.path} className={`entry ${e.kind}`}>
                  <span className="xy">
                    {e.staged}
                    {e.unstaged}
                  </span>
                  <span className="path">
                    {e.orig_path ? `${e.orig_path} → ${e.path}` : e.path}
                  </span>
                </li>
              ))}
            </ul>
          </aside>
        </div>
      )}

      {!repo && !error && (
        <div className="empty">
          <p>Abre un repositorio para empezar.</p>
        </div>
      )}
    </div>
  );
}

export default App;
