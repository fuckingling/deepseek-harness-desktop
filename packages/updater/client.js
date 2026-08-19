window.__ModuleLoader__.load({
	id: "dsh-launcher-updater",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");

		/* ──────────────────────────────── i18n ──────────────────────────────── */
		const NS = "launcher.updates";
		const NSB = "launcher.backup";

		const zhB = {
			nav: "备份与还原",
			title: "聊天记录备份与还原",
			about: "备份包含全部会话记录（storages）与聊天中粘贴的图片（attachments），可完整还原。",
			storageSize: "聊天记录占用",
			backupCount: "本地备份",
			create: "创建备份",
			creating: "正在创建备份…",
			created: "备份完成",
			download: "下载",
			restore: "还原",
			confirmRestore: "确认还原（将重启并替换当前聊天记录）",
			restoring: "正在还原…",
			restarting: "正在重启 Harness，页面即将重新连接…",
			uploadRestore: "从备份文件还原",
			chooseFile: "选择备份文件（.tar.gz）",
			delete: "删除",
			none: "暂无本地备份。",
			warnRestore: "还原会用备份覆盖当前聊天记录（当前记录会先保留一份 .pre-restore 快照），并重启 Harness。",
			failed: "操作失败",
			unsupported: "备份与还原功能仅在 DeepSeek Harness 桌面启动器中可用。",
			lastBackup: "上次备份",
			file: "文件",
			size: "大小",
			time: "时间",
			actions: "操作",
		};
		const enB = {
			nav: "Backup & Restore",
			title: "Chat history backup & restore",
			about: "Backs up every session record (storages) and pasted chat images (attachments); restores them completely.",
			storageSize: "Chat data size",
			backupCount: "Local backups",
			create: "Create backup",
			creating: "Creating backup…",
			created: "Backup created",
			download: "Download",
			restore: "Restore",
			confirmRestore: "Confirm restore (restarts and replaces current chat history)",
			restoring: "Restoring…",
			restarting: "Restarting the harness; the page will reconnect…",
			uploadRestore: "Restore from a backup file",
			chooseFile: "Choose a backup file (.tar.gz)",
			delete: "Delete",
			none: "No local backups yet.",
			warnRestore: "Restoring replaces the current chat history with the backup (the current records are snapshotted aside as .pre-restore first) and restarts the harness.",
			failed: "Operation failed",
			unsupported: "Backup & restore are available only in the DeepSeek Harness desktop launcher.",
			lastBackup: "Last backup",
			file: "File",
			size: "Size",
			time: "Time",
			actions: "Actions",
		};

		const zh = {
			nav: "更新",
			title: "更新 Harness",
			current: "当前版本",
			runtimeVersion: "Harness 运行时",
			dshVersion: "DSH 版本",
			appVersion: "启动器版本",
			channel: "更新通道",
			feed: "更新源",
			check: "检查更新",
			checking: "正在检查…",
			upToDate: "已是最新版本",
			available: "发现新版本 {version}",
			notes: "更新说明",
			update: "更新并重启",
			downloading: "正在下载更新…",
			verifying: "正在校验…",
			applying: "正在应用更新…",
			restarting: "正在重启 Harness，页面即将重新连接…",
			restart: "重启 Harness",
			unsupported: "更新功能仅在 DeepSeek Harness 桌面启动器中可用。",
			warn: "更新会重启 Harness，进行中的会话可能中断。",
			failed: "操作失败",
			noFeed: "未配置启动器更新源；官方 Harness 更新仍可用。",
			officialLatest: "官方最新",
			officialAvailable: "（可更新）",
			notesOfficial: "官方已发布 @deepseek-ai/dsh {version}。更新将从官方 npm registry 安装（应用内置 npm，不触碰系统环境）。",
			autoCheck: "自动检查更新",
			autoCheckHint: "每天在设定时间自动检查官方新版本，发现更新后在此页面手动安装。",
			autoTime: "检查时间",
			nextCheck: "下次自动检查",
			unknown: "未知",
			checkedAt: "上次检查",
		};
		const en = {
			nav: "Updates",
			title: "Update Harness",
			current: "Current version",
			runtimeVersion: "Harness runtime",
			dshVersion: "DSH version",
			appVersion: "Launcher version",
			channel: "Channel",
			feed: "Update source",
			check: "Check for updates",
			checking: "Checking…",
			upToDate: "You are up to date",
			available: "New version {version} available",
			notes: "Release notes",
			update: "Update & restart",
			downloading: "Downloading update…",
			verifying: "Verifying…",
			applying: "Applying update…",
			restarting: "Restarting the harness; the page will reconnect…",
			restart: "Restart harness",
			unsupported: "Updates are available only in the DeepSeek Harness desktop launcher.",
			warn: "Updating restarts the harness; active sessions may be interrupted.",
			failed: "Operation failed",
			noFeed: "No launcher feed configured; official harness updates still work.",
			officialLatest: "Official latest",
			officialAvailable: " (update available)",
			notesOfficial: "Official @deepseek-ai/dsh {version} is available. The update installs from the official npm registry (bundled npm, nothing touches your system).",
			autoCheck: "Auto-check for updates",
			autoCheckHint: "Checks the official registry daily at the set time; install manually from this page when an update is found.",
			autoTime: "Check time",
			nextCheck: "Next auto check",
			unknown: "Unknown",
			checkedAt: "Last checked",
		};

		/* ─────────────────────────────── wire api ────────────────────────────── */
		async function api(method, body) {
			const response = await fetch(`/launcher-updater/${method}`, {
				method: body === undefined ? "GET" : "POST",
				headers: body === undefined ? undefined : { "content-type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			let payload = null;
			try {
				payload = await response.json();
			} catch {
				throw new Error(`launcher-updater: ${method} 响应不是 JSON (${response.status})`);
			}
			if (!response.ok || payload.ok !== true) {
				throw new Error((payload && payload.error) || `请求失败 (${response.status})`);
			}
			return payload.status;
		}

		function fmtBytes(n) {
			if (!Number.isFinite(n)) return "…";
			if (n < 1024) return `${n} B`;
			if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
			return `${(n / 1024 / 1024).toFixed(1)} MB`;
		}

		function fmtTime(iso) {
			if (iso === null || iso === "") return null;
			const date = new Date(iso);
			return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
		}

		/* ──────────────────────────────── styles ─────────────────────────────── */
		const styles = {
			wrap: { display: "flex", flexDirection: "column", gap: "16px" },
			card: {
				border: "1px solid rgba(128, 128, 128, 0.35)",
				borderRadius: "10px",
				padding: "16px",
				display: "flex",
				flexDirection: "column",
				gap: "12px",
			},
			title: { margin: 0, fontSize: "15px", fontWeight: 600 },
			rows: { display: "flex", flexDirection: "column", gap: "6px" },
			row: { display: "flex", justifyContent: "space-between", gap: "16px", fontSize: "13px" },
			key: { opacity: 0.72 },
			value: { fontVariantNumeric: "tabular-nums", textAlign: "right", wordBreak: "break-all", maxWidth: "70%" },
			mono: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12px" },
			status: { fontSize: "13px", fontWeight: 500 },
			ok: { color: "#16a34a" },
			info: { opacity: 0.85 },
			err: { color: "#dc2626" },
			actions: { display: "flex", gap: "8px", flexWrap: "wrap" },
			button: {
				appearance: "none",
				border: "1px solid rgba(128, 128, 128, 0.45)",
				background: "transparent",
				color: "inherit",
				borderRadius: "7px",
				padding: "6px 14px",
				fontSize: "13px",
				cursor: "pointer",
			},
			buttonPrimary: {
				appearance: "none",
				border: "1px solid transparent",
				background: "#2563eb",
				color: "#ffffff",
				borderRadius: "7px",
				padding: "6px 14px",
				fontSize: "13px",
				cursor: "pointer",
			},
			notes: {
				border: "1px solid rgba(128, 128, 128, 0.35)",
				borderRadius: "8px",
				padding: "10px 12px",
				fontSize: "12.5px",
				whiteSpace: "pre-wrap",
				maxHeight: "220px",
				overflowY: "auto",
			},
			statBar: { display: "flex", alignItems: "stretch", border: "1px solid rgba(128,128,128,0.35)", borderRadius: "12px", overflow: "hidden" },
			statItem: { flex: "1 1 0", minWidth: 0, padding: "14px 12px", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "4px", textAlign: "center" },
			statDivider: { width: "1px", background: "rgba(128,128,128,0.25)" },
			statBig: { fontSize: "20px", fontWeight: 650, fontVariantNumeric: "tabular-nums" },
			statLabel: { fontSize: "12px", opacity: 0.72 },
			statSub: { fontSize: "11px", opacity: 0.6, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
			warn: { fontSize: "12.5px", opacity: 0.8 },
		};

		/* ──────────────────────────────── section ────────────────────────────── */
		function UpdaterSection(props) {
			const t = props.t;
			const [status, setStatus] = React.useState(null);
			const [busy, setBusy] = React.useState(false);
			const [error, setError] = React.useState(null);
			// The poll effect closes over the first render; the current phase
			// rides a ref so restart suppression always sees the live value.
			const phaseRef = React.useRef("loading");
			phaseRef.current = status === null ? "loading" : status.phase;

			React.useEffect(() => {
				let alive = true;
				let timer = null;
				const load = async () => {
					try {
						const snapshot = await api("status");
						if (alive) {
							setStatus(snapshot);
							setError(null);
						}
					} catch (err) {
						// While the harness is restarting the server is down by
						// design; keep the last good snapshot instead of noise.
						if (alive && phaseRef.current !== "restarting") {
							setError(err instanceof Error ? err.message : String(err));
						}
					}
				};
				void load();
				timer = setInterval(load, 2000);
				return () => {
					alive = false;
					if (timer !== null) clearInterval(timer);
				};
			}, []); // eslint-disable-line react-hooks/exhaustive-deps

			const run = async (method, body) => {
				setBusy(true);
				setError(null);
				try {
					const snapshot = await api(method, body);
					setStatus(snapshot);
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
				} finally {
					setBusy(false);
				}
			};

			const runSettings = async (patch) => {
				setError(null);
				try {
					const snapshot = await api("settings", patch);
					setStatus(snapshot);
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
				}
			};

			const phase = status === null ? "loading" : status.phase;
			const restarting = phase === "restarting" || (status !== null && status.restartRequested === true);

			let statusLine = null;
			if (status === null) {
				statusLine = React.createElement("div", { style: { ...styles.status, ...styles.info } }, "…");
			} else if (restarting) {
				statusLine = React.createElement("div", { style: { ...styles.status, ...styles.info } }, t("restarting"));
			} else if (phase === "checking") {
				statusLine = React.createElement("div", { style: { ...styles.status, ...styles.info } }, t("checking"));
			} else if (phase === "downloading" && status.progress !== null) {
				const total = status.progress.total === null
					? fmtBytes(status.progress.received)
					: `${fmtBytes(status.progress.received)} / ${fmtBytes(status.progress.total)}`;
				statusLine = React.createElement("div", { style: { ...styles.status, ...styles.info } }, `${t("downloading")} ${total}`);
			} else if (phase === "verifying") {
				statusLine = React.createElement("div", { style: { ...styles.status, ...styles.info } }, t("verifying"));
			} else if (phase === "applying") {
				statusLine = React.createElement("div", { style: { ...styles.status, ...styles.info } }, t("applying"));
			} else if (status.updateAvailable === true) {
				statusLine = React.createElement(
					"div",
					{ style: { ...styles.status, ...styles.ok } },
					t("available").replace("{version}", status.latest !== null ? status.latest.version : ""),
				);
			} else {
				statusLine = React.createElement("div", { style: { ...styles.status, ...styles.ok } }, t("upToDate"));
			}

			const errorLine = error !== null
				? React.createElement("div", { style: { ...styles.status, ...styles.err } }, `${t("failed")}: ${error}`)
				: null;

			const versionRows = [
				[t("runtimeVersion"), status === null ? "" : status.runtimeVersion || t("unknown")],
				[t("dshVersion"), status === null ? "" : status.dshVersion || t("unknown")],
				[
					t("officialLatest"),
					status === null || status.officialLatest === null
						? (status === null ? "" : t("unknown"))
						: `${status.officialLatest.version}${status.officialUpdateAvailable === true ? ` ${t("officialAvailable")}` : ""}`,
				],
				[t("appVersion"), status === null ? "" : status.appVersion || t("unknown")],
				[t("channel"), status === null ? "" : status.channel || t("unknown")],
			];
			const checkedAt = status !== null ? fmtTime(status.checkedAt) : null;
			const feedUrl = status !== null ? status.feedUrl : "";

			if (status !== null && status.supported === false) {
				return React.createElement("div", { style: styles.wrap },
					React.createElement("div", { style: styles.card },
						React.createElement("h3", { style: styles.title }, t("title")),
						React.createElement("div", { style: { ...styles.status, ...styles.info } }, t("unsupported")),
					),
				);
			}

			const actions = [];
			actions.push(
				React.createElement("button", {
					key: "check",
					style: styles.button,
					disabled: busy || restarting || phase !== "idle",
					onClick: () => void run("check"),
				}, t("check")),
			);
			if (status !== null && status.updateAvailable === true) {
				actions.push(
					React.createElement("button", {
						key: "apply",
						style: styles.buttonPrimary,
						disabled: busy || restarting,
						onClick: () => void run("apply"),
					}, t("update")),
				);
			}
			if (status !== null && status.supported !== false) {
				actions.push(
					React.createElement("button", {
						key: "restart",
						style: styles.button,
						disabled: busy || restarting,
						onClick: () => void run("restart"),
					}, t("restart")),
				);
			}

			const notesBlock = (() => {
				if (status === null || status.updateAvailable !== true || status.latest === null) return null
				if (status.updateSource === "npm") {
					return React.createElement("div", { style: styles.notes }, t("notesOfficial").replace("{version}", status.latest.version))
				}
				if (status.latest.notes !== "") {
					return React.createElement("div", { style: styles.notes }, status.latest.notes)
				}
				return null
			})();

			const autoCheckBlock = status === null ? null : React.createElement("div", { style: styles.card },
				React.createElement("div", { style: styles.row },
					React.createElement("label", { style: { display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", cursor: "pointer" } },
						React.createElement("input", {
							type: "checkbox",
							checked: status.autoCheck === true,
							disabled: busy || restarting,
							onChange: event => void runSettings({ autoCheck: event.target.checked }),
						}),
						t("autoCheck"),
					),
				),
				React.createElement("div", { style: { ...styles.warn, fontSize: "12px" } }, t("autoCheckHint")),
				status.autoCheck === true ? React.createElement("div", { style: styles.row },
					React.createElement("span", { style: styles.key }, t("autoTime")),
					React.createElement("input", {
						type: "time",
						value: status.autoCheckTime ?? "03:00",
						disabled: busy || restarting,
						style: { ...styles.button, cursor: "pointer" },
						onChange: event => void runSettings({ autoCheckTime: event.target.value }),
					}),
				) : null,
				status.autoCheck === true && status.nextAutoCheckAt !== null && status.nextAutoCheckAt !== undefined
					? React.createElement("div", { style: styles.warn }, `${t("nextCheck")}: ${fmtTime(status.nextAutoCheckAt) ?? ""}`)
					: null,
			);

			return React.createElement("div", { style: styles.wrap },
				React.createElement("div", { style: styles.card },
					React.createElement("h3", { style: styles.title }, t("title")),
					React.createElement("div", { style: styles.rows },
						...versionRows.map(([k, v]) => React.createElement("div", { key: k, style: styles.row },
							React.createElement("span", { style: styles.key }, k),
							React.createElement("span", { style: styles.value }, v),
						)),
						checkedAt === null ? null : React.createElement("div", { style: styles.row },
							React.createElement("span", { style: styles.key }, t("checkedAt")),
							React.createElement("span", { style: styles.value }, checkedAt),
						),
					),
					statusLine,
					errorLine,
					notesBlock,
					status !== null && status.updateAvailable === true
						? React.createElement("div", { style: styles.warn }, t("warn"))
						: null,
					React.createElement("div", { style: styles.actions }, actions),
					feedUrl === ""
						? React.createElement("div", { style: styles.warn }, t("noFeed"))
						: React.createElement("div", { style: { ...styles.warn, ...styles.mono } }, `${t("feed")}: ${feedUrl}`),
				),
				autoCheckBlock,
			);
		}

		/* ───────────────────────────── backup wire api ────────────────────────── */
		async function apiB(method, body) {
			const response = await fetch(`/launcher-backup/${method}`, {
				method: body === undefined ? "GET" : "POST",
				headers: body === undefined ? undefined : { "content-type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			let payload = null;
			try {
				payload = await response.json();
			} catch {
				throw new Error(`launcher-backup: ${method} 响应不是 JSON (${response.status})`);
			}
			if (!response.ok || payload.ok !== true) {
				throw new Error((payload && payload.error) || `请求失败 (${response.status})`);
			}
			return payload.status;
		}

		/* ─────────────────────── backup & restore section ────────────────────── */
		function BackupSection(props) {
			const t = props.t;
			const [status, setStatus] = React.useState(null);
			const [busy, setBusy] = React.useState(false);
			const [error, setError] = React.useState(null);
			const [confirmName, setConfirmName] = React.useState(null);
			const fileRef = React.useRef(null);
			const phaseRef = React.useRef("idle");
			phaseRef.current = status === null ? "idle" : status.phase;

			React.useEffect(() => {
				let alive = true;
				let timer = null;
				const load = async () => {
					try {
						const snapshot = await apiB("status");
						if (alive) {
							setStatus(snapshot);
							setError(null);
						}
					} catch (err) {
						if (alive && phaseRef.current !== "restarting") {
							setError(err instanceof Error ? err.message : String(err));
						}
					}
				};
				void load();
				timer = setInterval(load, 2500);
				return () => {
					alive = false;
					if (timer !== null) clearInterval(timer);
				};
			}, []); // eslint-disable-line react-hooks/exhaustive-deps

			const run = async (fn) => {
				setBusy(true);
				setError(null);
				try {
					const snapshot = await fn();
					setStatus(snapshot);
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
				} finally {
					setBusy(false);
				}
			};

			const doRestore = async (payload) => {
				setBusy(true);
				setError(null);
				try {
					const snapshot = await apiB("restore", payload);
					setStatus(snapshot);
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
				} finally {
					setBusy(false);
				}
			};

			const onFile = (file) => {
				if (file === null) return
				const reader = new FileReader()
				reader.onload = () => {
					const base64 = String(reader.result ?? "").split(",").pop() ?? ""
					if (base64 !== "") void doRestore({ base64 })
				}
				reader.readAsDataURL(file)
			};

			if (status !== null && status.supported === false) {
				return React.createElement("div", { style: styles.wrap },
					React.createElement("div", { style: styles.card },
						React.createElement("h3", { style: styles.title }, t("title")),
						React.createElement("div", { style: { ...styles.status, ...styles.info } }, t("unsupported")),
					),
				);
			}

			const restarting = status !== null && status.phase === "restarting";
			if (restarting) {
				return React.createElement("div", { style: styles.wrap },
					React.createElement("div", { style: styles.card },
						React.createElement("h3", { style: styles.title }, t("title")),
						React.createElement("div", { style: { ...styles.status, ...styles.info } }, t("restarting")),
					),
				);
			}

			const backups = status === null ? [] : (status.backups ?? []);
			const bytes = status === null ? 0 : (status.storagesBytes ?? 0) + (status.sessionsBytes ?? 0) + (status.attachmentsBytes ?? 0);
			const lastBackup = status === null ? null : status.lastBackup;
			const lastBackupAt = lastBackup === null ? null : fmtTime(lastBackup.at);

			const row = (k, v) => React.createElement("div", { key: k, style: styles.row },
				React.createElement("span", { style: styles.key }, k),
				React.createElement("span", { style: styles.value }, v),
			);

			const backupRows = backups.map(b => {
				const name = b.name;
				const confirm = confirmName === name;
				return React.createElement("div", { key: name, style: { ...styles.row, alignItems: "center" } },
					React.createElement("span", { style: { ...styles.mono, flex: 1, wordBreak: "break-all" } }, name),
					React.createElement("span", { style: styles.key }, fmtBytes(b.sizeBytes)),
					React.createElement("span", { style: styles.key }, fmtTime(b.at) ?? ""),
					React.createElement("a", {
						href: `/launcher-backup/download?name=${encodeURIComponent(name)}`,
						style: styles.button,
						onClick: e => e.stopPropagation(),
					}, t("download")),
					React.createElement("button", {
						style: confirm ? styles.buttonPrimary : styles.button,
						disabled: busy,
						onClick: () => {
							if (!confirm) { setConfirmName(name); return }
							setConfirmName(null)
							void doRestore({ file: name })
						},
					}, confirm ? t("confirmRestore") : t("restore")),
					React.createElement("button", {
						style: styles.button,
						disabled: busy,
						onClick: () => void run(async () => apiB("delete", { name })),
					}, t("delete")),
				);
			});

			return React.createElement("div", { style: styles.wrap },
				React.createElement("div", { style: styles.card },
					React.createElement("h3", { style: styles.title }, t("title")),
					React.createElement("div", { style: styles.warn }, t("about")),
					React.createElement("div", { style: styles.rows },
						row(t("storageSize"), fmtBytes(bytes)),
						row(t("backupCount"), String(backups.length)),
						lastBackup === null ? null : row(t("lastBackup"), `${lastBackup.name} (${lastBackupAt ?? ""})`),
					),
					error !== null
						? React.createElement("div", { style: { ...styles.status, ...styles.err } }, `${t("failed")}: ${error}`)
						: null,
					React.createElement("div", { style: styles.actions },
						React.createElement("button", {
							style: styles.buttonPrimary,
							disabled: busy,
							onClick: () => void run(async () => apiB("create")),
						}, busy ? t("creating") : t("create")),
					),
				),
				React.createElement("div", { style: styles.card },
					React.createElement("div", { style: styles.title }, t("uploadRestore")),
					React.createElement("div", { style: styles.warn }, t("warnRestore")),
					React.createElement("input", {
						ref: fileRef,
						type: "file",
						accept: ".tar.gz,application/gzip",
						style: { display: "none" },
						onChange: event => {
							onFile(event.target.files && event.target.files[0] ? event.target.files[0] : null)
							event.target.value = ""
						},
					}),
					React.createElement("div", { style: styles.actions },
						React.createElement("button", {
							style: styles.button,
							disabled: busy,
							onClick: () => { if (fileRef.current !== null) fileRef.current.click() },
						}, t("chooseFile")),
					),
				),
				React.createElement("div", { style: styles.card },
					React.createElement("div", { style: styles.title }, t("backupCount")),
					backups.length === 0
						? React.createElement("div", { style: styles.warn }, t("none"))
						: React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: "6px" } }, backupRows),
				),
			);
		}


		/* ───────────────────────────── personal i18n ──────────────────────────── */
		const NSP = "launcher.personal";
		const zhP = {
			nav: "个人中心",
			title: "个人中心",
			totalTokens: "累计 Token",
			peakDay: "峰值",
			longestSession: "最长持续时间",
			streak: "连续天数",
			input: "输入",
			cacheHit: "缓存命中",
			cacheMiss: "缓存未命中",
			output: "输出",
			days: "天",
			heatmapTitle: "Token 活动",
			less: "少",
			more: "多",
			byModel: "模型调用排行",
			model: "模型",
			noData: "还没有聊天记录。开始对话后，这里会出现统计。",
			attributionHint: "按天统计来自会话记录；无逐条用量时按会话最后活跃日归集。",
			failed: "操作失败",
			sessions: "会话数",
		};
		const enP = {
			nav: "Personal",
			title: "Personal center",
			totalTokens: "Total tokens",
			peakDay: "Peak day",
			longestSession: "Longest session",
			streak: "Streak",
			input: "Input",
			cacheHit: "Cache hit",
			cacheMiss: "Cache miss",
			output: "Output",
			days: "days",
			heatmapTitle: "Token activity",
			less: "Less",
			more: "More",
			byModel: "Model ranking",
			model: "Model",
			noData: "No chat records yet — stats appear once you start chatting.",
			attributionHint: "Daily figures come from session records; sessions without per-message usage are attributed to their last-activity day.",
			failed: "Operation failed",
			sessions: "Sessions",
		};

		/* ───────────────────────────── personal wire ──────────────────────────── */
		async function apiP(method, body) {
			const response = await fetch(`/launcher-personal/${method}`, {
				method: body === undefined ? "GET" : "POST",
				headers: body === undefined ? undefined : { "content-type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			let payload = null;
			try {
				payload = await response.json();
			} catch {
				throw new Error(`launcher-personal: ${method} 响应不是 JSON (${response.status})`);
			}
			if (!response.ok || payload.ok !== true) {
				throw new Error((payload && payload.error) || `请求失败 (${response.status})`);
			}
			return payload.status;
		}

		function fmtTokens(n) {
			if (n < 1000) return String(Math.round(n));
			if (n < 1000000) return `${(n / 1000).toFixed(1)}K`;
			return `${(n / 1e6).toFixed(2)}M`;
		}

		function fmtDur(ms) {
			if (ms <= 0) return "—";
			const m = Math.floor(ms / 60000);
			if (m < 60) return `${m} 分钟`;
			const h = Math.floor(m / 60);
			const mm = m % 60;
			return mm === 0 ? `${h} 小时` : `${h} 小时 ${mm} 分`;
		}

		function heatColor(tokens, max) {
			if (tokens <= 0) return "rgba(128, 132, 145, 0.10)";
			const ratio = max <= 0 ? 0.05 : tokens / max;
			const level = ratio <= 0.25 ? 0.25 : (ratio <= 0.5 ? 0.45 : (ratio <= 0.75 ? 0.7 : 1));
			return `rgba(77, 107, 254, ${level})`;
		}

		/* ───────────────────────────── personal section ───────────────────────── */
		function PersonalSection(props) {
			const t = props.t;
			const [stats, setStats] = React.useState(null);
			const [error, setError] = React.useState(null);
			const [hover, setHover] = React.useState(null);


			React.useEffect(() => {
				let alive = true;
				let timer = null;
				const load = async () => {
					try {
						const snapshot = await apiP("status");
						if (alive) { setStats(snapshot); setError(null); }
					} catch (err) {
						if (alive) setError(err instanceof Error ? err.message : String(err));
					}
				};
				void load();
				timer = setInterval(load, 10000);
				return () => { alive = false; if (timer !== null) clearInterval(timer); };
			}, []); // eslint-disable-line react-hooks/exhaustive-deps

			if (stats !== null && stats.supported === false) {
				return React.createElement("div", { style: styles.wrap },
					React.createElement("div", { style: styles.card },
						React.createElement("h3", { style: styles.title }, t("title")),
						React.createElement("div", { style: { ...styles.status, ...styles.info } }, t("noData")),
					),
				);
			}
			if (stats === null) {
				return React.createElement("div", { style: styles.wrap },
					React.createElement("div", { style: styles.card }, React.createElement("div", { style: styles.status }, "…")),
				);
			}

			const totals = stats.totals ?? { input: 0, cacheHit: 0, cacheMiss: 0, output: 0, tokens: 0, cost: 0 };
			const peak = stats.peak;
			const longest = stats.longest;
			// Codex-style stat bar: one rounded card, centered value-over-label
			// cells separated by hairline dividers.
			const statItem = (key, big, label, sub) => React.createElement("div", { key, style: styles.statItem },
				React.createElement("div", { style: styles.statBig }, big),
				React.createElement("div", { style: styles.statLabel }, label),
				sub === null || sub === undefined ? null : React.createElement("div", { style: styles.statSub }, sub),
			);

			const cards = React.createElement("div", { style: styles.statBar },
				statItem("total", fmtTokens(totals.tokens), t("totalTokens"),
					`${t("input")} ${fmtTokens(totals.input + totals.cacheMiss)} · ${t("cacheHit")} ${fmtTokens(totals.cacheHit)} · ${t("output")} ${fmtTokens(totals.output)}`),
				React.createElement("div", { key: "d1", style: styles.statDivider }),
				statItem("peak", peak === null ? "—" : fmtTokens(peak.tokens), t("peakDay"), peak === null ? null : peak.date),
				React.createElement("div", { key: "d2", style: styles.statDivider }),
				statItem("longest", longest === null ? "—" : fmtDur(longest.spanMs), t("longestSession"), longest === null ? null : (longest.title || (longest.model || "").slice(0, 60))),
				React.createElement("div", { key: "d3", style: styles.statDivider }),
				statItem("streak", `${stats.streak ?? 0} ${t("days")}`, t("streak"), `${t("sessions")} ${stats.sessions ?? 0}`),
			);

			// heatmap: the full calendar year (Jan–Dec), Monday-aligned full-width
			// grid; days after today render lighter, out-of-year padding invisible
			const DAY_MS_P = 24 * 60 * 60 * 1000;
			const heat = stats.heatmap ?? [];
			const maxTokens = heat.reduce((m, d) => Math.max(m, d.tokens), 1);
			const dateOf = key => new Date(`${key}T00:00:00`);
			const yearFirst = heat.length > 0 ? heat[0].date : null;
			const yearLast = heat.length > 0 ? heat[heat.length - 1].date : null;
			const startDate = yearFirst === null ? new Date() : dateOf(yearFirst);
			const startMonday = new Date(startDate.getTime() - ((startDate.getDay() + 6) % 7) * DAY_MS_P);
			const endDate = yearLast === null ? new Date() : dateOf(yearLast);
			const endSaturday = new Date(endDate.getTime() + (6 - ((endDate.getDay() + 6) % 7)) * DAY_MS_P);
			const heatByDate = new Map(heat.map(d => [d.date, d]));
			const cells = [];
			for (let t = startMonday.getTime(); t <= endSaturday.getTime(); t += DAY_MS_P) {
				const d = new Date(t);
				const pad2 = n => String(n).padStart(2, "0");
				const key = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
				const day = heatByDate.get(key);
				cells.push(day !== undefined ? day : { date: key, tokens: 0, cost: 0, sessions: 0, outOfRange: true });
			}
			const weeks = [];
			for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
			const weekCount = weeks.length;
			const monthLabels = weeks.map((week, wi) => {
				const first = week.find(d => d.outOfRange !== true);
				if (first === undefined) return null;
				const prev = wi === 0 ? null : (() => { const f = weeks[wi - 1].find(d => d.outOfRange !== true); return f === undefined ? null : f.date.slice(0, 7) })();
				const cur = first.date.slice(0, 7);
				return cur !== prev ? `${Number(cur.slice(5))}月` : null;
			});
			const gridStyle = { display: "grid", gridTemplateColumns: `repeat(${weekCount}, 1fr)`, gap: "2px", width: "100%" };
			const heatCell = (day, x, y) => React.createElement("div", {
				key: `${x}-${y}`,
				style: {
					width: "100%",
					aspectRatio: "1 / 1",
					borderRadius: "2px",
					background: day.outOfRange === true ? "transparent" : (day.future === true ? "rgba(128, 132, 145, 0.05)" : heatColor(day.tokens, maxTokens)),
					cursor: day.outOfRange === true || day.future === true ? "default" : "pointer",
				},
				...(day.outOfRange === true || day.future === true ? {} : { onMouseEnter: () => setHover(day), onMouseLeave: () => setHover(null) }),
			});
			const heatmap = React.createElement("div", { style: styles.card },
				React.createElement("div", { style: { ...styles.title, display: "flex", justifyContent: "space-between" } },
					React.createElement("span", null, t("heatmapTitle")),
					React.createElement("span", { style: { fontSize: "11px", opacity: 0.75, fontFamily: "ui-monospace, Menlo, monospace" } },
						hover === null ? "" : `${hover.date} · ${fmtTokens(hover.tokens)}`),
				),
				React.createElement("div", { style: gridStyle },
					weeks.map((week, wi) => React.createElement("div", { key: wi, style: { display: "flex", flexDirection: "column", gap: "3px" } },
						week.map((day, di) => heatCell(day, wi, di)),
					)),
				),
				React.createElement("div", { style: { ...gridStyle, marginTop: "4px", minHeight: "14px" } },
					monthLabels.map((label, wi) => React.createElement("div", { key: wi, style: { fontSize: "10px", opacity: 0.65, whiteSpace: "nowrap", overflow: "visible" } }, label ?? "")),
				),
				React.createElement("div", { style: { display: "flex", justifyContent: "flex-end", alignItems: "center", gap: "4px", marginTop: "8px", fontSize: "11px", opacity: 0.7 } },
					t("less"),
					[0.1, 0.35, 0.6, 0.85, 1].map(level => React.createElement("div", { key: level, style: { width: "12px", height: "12px", borderRadius: "3px", background: `rgba(77, 107, 254, ${level})` } })),
					t("more"),
				),
			);

			// by-model ranking: real model names, sorted by usage (descending)
			const models = stats.byModel ?? [];
			const shareBase = totals.tokens > 0 ? totals.tokens : 1;
			const modelRows = models.map((m, i) => React.createElement("div", { key: m.model, style: styles.row },
				React.createElement("span", { style: styles.key },
					React.createElement("span", { style: { ...styles.mono, opacity: 0.6, marginRight: "8px" } }, String(i + 1).padStart(2, "0")),
					m.model,
				),
				React.createElement("span", { style: styles.value }, `${fmtTokens(m.tokens)} · ${Math.round((m.tokens / shareBase) * 100)}%`),
			));
			const modelCard = React.createElement("div", { style: styles.card },
				React.createElement("div", { style: styles.title }, t("byModel")),
				React.createElement("div", { style: styles.rows },
					models.length === 0 ? React.createElement("div", { style: styles.warn }, t("noData")) : modelRows,
				),
			);

			return React.createElement("div", { style: styles.wrap },
				cards,
				heatmap,
				modelCard,
				error !== null ? React.createElement("div", { style: { ...styles.status, ...styles.err } }, `${t("failed")}: ${error}`) : null,
				React.createElement("div", { style: styles.warn }, t("attributionHint")),
			);
		}

		/* ─────────────────────────────── plugin body ─────────────────────────── */
		const inject = ["slots", "locale"];

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-launcher-updater: copy dictionaries");
			ctx.effect(() => ctx.locale.register(NSB, { zh: zhB, en: enB }), "dsh-launcher-updater: backup copy dictionaries");
			const t = ctx.locale.bind(NS);
			const tb = ctx.locale.bind(NSB);
			const injected = () => ({ t });
			const injectedB = () => ({ t: tb });
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "updates",
				order: 500,
				label: () => t("nav"),
				inject: injected,
			}, UpdaterSection));
			ctx.effect(() => ctx.locale.register(NSP, { zh: zhP, en: enP }), "dsh-launcher-updater: personal copy dictionaries");
			const tp = ctx.locale.bind(NSP);
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "personal",
				order: -10,
				label: () => tp("nav"),
				inject: () => ({ t: tp }),
			}, PersonalSection));
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "backup",
				order: 450,
				label: () => tb("nav"),
				inject: injectedB,
			}, BackupSection));
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
