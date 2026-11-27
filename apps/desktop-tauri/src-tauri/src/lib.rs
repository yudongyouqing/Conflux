use std::env;
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::thread;
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, Theme, WebviewUrl, WebviewWindowBuilder, WindowEvent};

const DEFAULT_PORT: u16 = 9527;
const DEFAULT_BIND_HOST: &str = "0.0.0.0";

struct ManagedServer {
    child: Mutex<Option<Child>>,
    quitting: AtomicBool,
}

impl ManagedServer {
    fn new(child: Option<Child>) -> Self {
        Self {
            child: Mutex::new(child),
            quitting: AtomicBool::new(false),
        }
    }

    fn stop(&self) {
        self.quitting.store(true, Ordering::SeqCst);
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

impl Drop for ManagedServer {
    fn drop(&mut self) {
        self.stop();
    }
}

pub fn resolve_port(raw: Option<&str>) -> u16 {
    raw.and_then(|s| s.trim().parse::<u16>().ok())
        .filter(|&p| p > 0)
        .unwrap_or(DEFAULT_PORT)
}

pub fn build_app_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/")
}

pub fn check_port_listening(port: u16, timeout_ms: u64) -> bool {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    TcpStream::connect_timeout(&addr, Duration::from_millis(timeout_ms)).is_ok()
}

pub fn resolve_server_entry_from_roots(roots: &[PathBuf]) -> Option<PathBuf> {
    let candidates = [
        "apps/server/dist/index.js",
        "server/dist/index.js",
        "resources/server/dist/index.js",
    ];
    for root in roots {
        for rel in &candidates {
            let candidate = root.join(rel);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn discover_server_entry(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(explicit) = env::var("CONFLUX_SERVER_ENTRY") {
        let p = PathBuf::from(explicit.trim());
        if p.is_file() {
            return Some(p);
        }
    }

    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(res_dir) = app.path().resource_dir() {
        roots.push(res_dir);
    }
    if let Ok(exe) = env::current_exe() {
        if let Some(parent) = exe.parent() {
            roots.push(parent.to_path_buf());
            for ancestor in parent.ancestors().take(5) {
                roots.push(ancestor.to_path_buf());
            }
        }
    }
    if let Ok(cwd) = env::current_dir() {
        roots.push(cwd.clone());
        for ancestor in cwd.ancestors().take(4) {
            roots.push(ancestor.to_path_buf());
        }
    }
    // Compile-time monorepo root fallback for local cargo run / dev builds
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    if let Some(repo_root) = manifest_dir.parent().and_then(|p| p.parent()).and_then(|p| p.parent())
    {
        roots.push(repo_root.to_path_buf());
    }

    resolve_server_entry_from_roots(&roots)
}

fn spawn_local_node_server(entry: &Path, bind_host: &str, port: u16) -> Result<Child, String> {
    let node_bin = env::var("CONFLUX_NODE_BIN")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "node".to_string());

    let mut cmd = Command::new(&node_bin);
    cmd.arg(entry)
        .arg("serve")
        .arg("--host")
        .arg(bind_host)
        .arg("--port")
        .arg(port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());

    if let Some(parent) = entry.parent().and_then(|p| p.parent()) {
        cmd.current_dir(parent);
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd.spawn()
        .map_err(|e| format!("failed to launch Node server ({node_bin}): {e}"))
}

fn wait_until_port_ready(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if check_port_listening(port, 120) {
            return true;
        }
        thread::sleep(Duration::from_millis(80));
    }
    false
}

pub fn build_desktop_bridge_script() -> String {
    let platform = if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "win32"
    } else {
        "linux"
    };

    format!(
        r#"(function () {{
  if (window.confluxDesktop) return;
  const invoke = (cmd, args) => window.__TAURI__?.core?.invoke(cmd, args);
  const pickDirectory = async () => {{
    try {{
      const picked = await invoke("pick_directory");
      return typeof picked === "string" ? picked : null;
    }} catch {{
      return null;
    }}
  }};
  window.confluxDesktop = Object.freeze({{
    isTauri: true,
    isElectron: false,
    platform: "{platform}",
    showWindow: () => {{ void invoke("show_window"); }},
    pickDirectory,
    pickProjectDirectory: pickDirectory,
    setNativeTheme: (mode) => {{ void invoke("set_native_theme", {{ mode: String(mode || "dark") }}); }},
  }});
}})();"#
    )
}

fn focus_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

#[tauri::command]
fn pick_directory() -> Option<String> {
    rfd::FileDialog::new()
        .pick_folder()
        .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
fn show_window(app: AppHandle) {
    focus_main_window(&app);
}

#[tauri::command]
fn set_native_theme(app: AppHandle, mode: String) {
    if let Some(win) = app.get_webview_window("main") {
        let theme = if mode.eq_ignore_ascii_case("light") {
            Theme::Light
        } else {
            Theme::Dark
        };
        let _ = win.set_theme(Some(theme));
    }
}

pub fn run() {
    let port = resolve_port(env::var("CONFLUX_PORT").ok().as_deref());
    let bind_host = env::var("CONFLUX_HOST")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_BIND_HOST.to_string());

    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            pick_directory,
            show_window,
            set_native_theme
        ])
        .setup(move |app| {
            let handle = app.handle();

            // Reuse existing healthy local Conflux server if already listening;
            // otherwise launch and own the local Node server process cleanly.
            let owned_child = if check_port_listening(port, 150) {
                None
            } else if let Some(entry) = discover_server_entry(handle) {
                match spawn_local_node_server(&entry, &bind_host, port) {
                    Ok(child) => {
                        let _ = wait_until_port_ready(port, Duration::from_secs(8));
                        Some(child)
                    }
                    Err(err) => {
                        eprintln!("[conflux-tauri] {err}");
                        None
                    }
                }
            } else {
                eprintln!("[conflux-tauri] server entry not found; run npm run build first");
                None
            };

            app.manage(ManagedServer::new(owned_child));

            // Native system tray with Show / Quit actions
            let show_item = MenuItem::with_id(app, "show", "显示 Conflux", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出 Conflux", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            let mut tray_builder = TrayIconBuilder::new()
                .menu(&tray_menu)
                .tooltip("Conflux · Personal Agent Mesh")
                .on_menu_event(|app_handle, event| match event.id.as_ref() {
                    "show" => focus_main_window(app_handle),
                    "quit" => {
                        if let Some(srv) = app_handle.try_state::<ManagedServer>() {
                            srv.stop();
                        }
                        app_handle.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        focus_main_window(tray.app_handle());
                    }
                });

            if let Some(icon) = app.default_window_icon().cloned() {
                tray_builder = tray_builder.icon(icon);
            }
            let _ = tray_builder.build(app)?;

            // Build main dark WebView window pointing at the local Conflux server
            let url = build_app_url(port)
                .parse()
                .expect("valid local Conflux server URL");

            let win = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("Conflux")
                .inner_size(1440.0, 900.0)
                .min_inner_size(960.0, 640.0)
                .theme(Some(Theme::Dark))
                .initialization_script(&build_desktop_bridge_script())
                .build()?;

            let app_handle = handle.clone();
            win.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    let quitting = app_handle
                        .try_state::<ManagedServer>()
                        .map(|s| s.quitting.load(Ordering::SeqCst))
                        .unwrap_or(false);
                    if !quitting && env::var("CONFLUX_QUIT_ON_LAST_WINDOW_CLOSED").as_deref() != Ok("1") {
                        api.prevent_close();
                        if let Some(w) = app_handle.get_webview_window("main") {
                            let _ = w.hide();
                        }
                    }
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Conflux Tauri shell");

    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            if let Some(srv) = app_handle.try_state::<ManagedServer>() {
                srv.stop();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::net::TcpListener;

    #[test]
    fn resolves_default_and_custom_ports() {
        assert_eq!(resolve_port(None), 9527);
        assert_eq!(resolve_port(Some("")), 9527);
        assert_eq!(resolve_port(Some("0")), 9527);
        assert_eq!(resolve_port(Some("invalid")), 9527);
        assert_eq!(resolve_port(Some("19527")), 19527);
        assert_eq!(build_app_url(9527), "http://127.0.0.1:9527/");
    }

    #[test]
    fn desktop_bridge_script_exposes_conflux_desktop_contract() {
        let script = build_desktop_bridge_script();
        assert!(script.contains("window.confluxDesktop"));
        assert!(script.contains("pickProjectDirectory"));
        assert!(script.contains("setNativeTheme"));
        assert!(script.contains("isTauri: true"));
    }

    #[test]
    fn detects_listening_and_closed_local_ports() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
        let port = listener.local_addr().unwrap().port();
        assert!(check_port_listening(port, 200));
        drop(listener);
        assert!(!check_port_listening(port, 120));
    }

    #[test]
    fn finds_server_entry_in_candidate_roots() {
        let base = env::temp_dir().join(format!("conflux-tauri-test-{}", std::process::id()));
        let entry = base.join("apps").join("server").join("dist").join("index.js");
        fs::create_dir_all(entry.parent().unwrap()).unwrap();
        fs::write(&entry, "// entry").unwrap();

        let found = resolve_server_entry_from_roots(&[base.clone()]);
        assert_eq!(found.as_deref(), Some(entry.as_path()));

        let _ = fs::remove_dir_all(&base);
    }
}
