# Install and run Shards Code

## Current distribution

This source snapshot does not include a Shards-hosted installer, published Shards npm package, or Shards Code release archive. Build the reviewed source checkout using the steps below. MiniMax's installer, npm package, website and support channels distribute the separate MiniMax product; they are not Shards Code downloads or support channels.

Shards Code is an independent fork. It is not affiliated with, endorsed by, or an official product of MiniMax. Original copyright, MIT attribution and required third-party notices remain in the repository and build archives.

## Build from source

You need Git, Node.js **22.19+ (22.x), 24.2+ (24.x), 25, or 26**, and pnpm **9.12.0**. The first build needs access to public npm. It also fetches a pinned, integrity-checked `mcode-tools` artifact from the public MiniMax npm package; this component is retained unchanged and its notices are included with the project notices.

On Windows, keep the checkout on a local NTFS volume outside cloud-synced folders and run the source-location check before installing dependencies.

```bash
git clone https://github.com/Shards-foundation/shards-code.git
cd shards-code
corepack enable
corepack prepare pnpm@9.12.0 --activate

# Windows only:
node scripts/check-windows-source-location.mjs

pnpm install --frozen-lockfile
pnpm build
pnpm shards-code --help
```

To start an interactive session from another project, use the built CLI by its full path:

```bash
cd /path/to/your/project
node /absolute/path/to/shards-code/dist/cli.js
```

You can also pass a task directly:

```bash
node /absolute/path/to/shards-code/dist/cli.js "Find a failing test, fix the implementation, and run the relevant tests."
```

From inside the checkout, `pnpm shards-code` runs the built CLI. The canonical executable is `shards-code`; `mcode` is retained as a compatibility alias for existing scripts and integrations. Neither command makes this fork an official MiniMax product.

## MiniMax account and API compatibility

MiniMax models, account authentication and API endpoints remain supported where configured. If you select MiniMax features, authentication and service requests go to MiniMax systems and remain subject to the provider's terms, availability, permissions and account limits. Shards Code does not provide a MiniMax account or inherit MiniMax support.

For compatibility with existing source builds, the default account-data directory remains `~/.minimax` (or `~/.minimax-<profile>` when a profile is selected). A non-empty `MINIMAX_DATA_DIR` takes precedence; otherwise a non-empty `MAVIS_DATA_DIR` is used before the default. These paths can contain login state, API keys, provider settings, caches and sessions. Keep them private and out of Git. Do not delete them when removing the source checkout unless you intentionally want to erase that account data.

The configuration package also recognizes its older `.mavis` data directory during its existing migration flow. If migration creates a backup, preserve it until you have confirmed that the new directory contains the data you need.

## Updates and installation paths

No public Shards Code release is available from this source snapshot. Managed automatic updates are disabled by default; the updater will not contact MiniMax's product-release feed. A reviewed Shards endpoint must be explicitly configured with `SHARDS_CODE_RELEASE_BASE_URL` before managed updates are available. The updater still recognizes legacy MiniMax package and signed-manifest identities for existing-installation compatibility.

For future managed installs, the default installation root is `$XDG_DATA_HOME/shards-code`, or `~/.local/share/shards-code` when `XDG_DATA_HOME` is unset; on Windows it is `%LOCALAPPDATA%\ShardsCode`. The legacy `MCODE_INSTALL_ROOT` override remains available. Installation files are separate from the account-data directory described above.

## macOS terminal shortcuts: Ghostty Option+M

In the composer, `Alt+M` (`Option+M` on macOS) cycles permission modes through Ask, Auto and Full access. Its binding ID is `composer.cycle-permission`. `Shift+Tab` toggles Plan mode, a separate setting. You can also use `/permission` to choose a mode and `/permission status` to inspect it without an Option shortcut.

If `Option+M` inserts `µ` instead, the terminal is sending text rather than the expected Alt shortcut. Shards Code preserves literal `µ` as text; it cannot safely infer a permission change from that character. The terminal must forward the modifier, or you can choose another binding.

### Configure Ghostty's Option key

Ghostty's [`macos-option-as-alt`](https://ghostty.org/docs/config/reference#macos-option-as-alt) default is **keyboard-layout dependent** when unset, not always `false`. The current reference lists U.S. Standard and U.S. International as defaulting to `true`; other layouts default to `false`. Check the active macOS input source and the configuration loaded by your installed Ghostty version.

Set this in your Ghostty configuration to send both Option keys as Alt:

```ini
macos-option-as-alt = true
```

Use `left` or `right` instead of `true` to reserve only that Option key for shortcuts and retain Unicode composition on the other side. Use the configured side when testing `Option+M`.

Follow Ghostty's [configuration locations and precedence](https://ghostty.org/docs/config#file-location): macOS-specific files load after XDG files, and later settings can override earlier ones. Inspect the loaded setting from the same Ghostty installation, without `--default`:

```bash
ghostty +show-config | awk '/^macos-option-as-alt[[:space:]]*=/'
```

If `ghostty` is not on `PATH`, use the executable inside your installed app bundle, typically `/Applications/Ghostty.app/Contents/MacOS/ghostty`. An empty or omitted value is not proof of `false`; unset behavior depends on the layout. After editing, reload Ghostty's configuration from its menu (default `Cmd+Shift+,`) and open a new terminal. This is separate from Shards Code's `/reload` command.

### Keep Option for text and customize Shards Code instead

While idle, open `/hotkeys`, select `composer.cycle-permission`, press `Enter`, press `Ctrl+X`, then press `Enter` to save. `Ctrl+X` is unused by the current default Shards Code bindings; check any custom terminal or multiplexer bindings too. Do not choose `Ctrl+M`: terminals commonly encode it identically to `Enter`.

Alternatively, merge this entry into `<data-dir>/tui/keybindings.json`, preserving any existing entries:

```json
{
  "composer.cycle-permission": "ctrl+x"
}
```

For the default profile this is `~/.minimax/tui/keybindings.json`; [profiles and data-directory overrides](#minimax-account-and-api-compatibility) change the path. Create the `tui` directory if needed. After editing the file, run `/reload` while idle with no pending interaction or queued message, or restart Shards Code. This replaces `Alt+M`; use `["alt+m", "ctrl+x"]` as the value to retain both bindings. `/hotkeys` shows the effective binding.

### Verify the result

With an idle composer and no open picker or permission prompt, note `/permission status`, press the configured shortcut, and check the status again. The mode should advance without inserting text. Restore your intended permission mode through `/permission` afterward. Confirm that `Shift+Tab` still toggles Plan mode and that pasting `µ` still inserts text.

If it still fails, record `shards-code --version`, Ghostty's version, active keyboard layout, which Option key you pressed, the setting above, the effective `/hotkeys` entry, and whether tmux or SSH is involved. Compare with a direct Ghostty session. Shards Code supports both legacy ESC-prefixed Alt input and extended keyboard reports; a shell's raw-key display alone does not establish what Ghostty sends after the TUI negotiates its keyboard protocol.

## Remove a source build

To remove only a source build, remove the checkout directory using your operating system's normal file manager or command. Do not remove `~/.minimax`, a profile directory, `.mavis`, or any migration backup unless you also intend to erase stored account data. If you separately installed the MiniMax product, use that product's own instructions; uninstalling one product does not safely identify or remove the other's files.

For account-data cleanup, first identify the active override and profile, export anything you need, and then remove only the exact data directory you intend to erase. Never use a broad wildcard to delete home-directory data.
