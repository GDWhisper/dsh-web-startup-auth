window.__ModuleLoader__.load({
	id: "dsh-web-startup-auth",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/session-limits.ts
		/**
		* Shared session-lifetime constants for the `dsh_sid` cookie.
		*
		* Dependency-free on purpose: the node half (credential-store / auth) and the
		* browser half (client bundle) both import it, so it must stay free of
		* `node:*` imports for tsdown to inline it into `lib/client.js`.
		*/
		/** Admin-selectable session lifetimes, in days (settings tab "会话有效期"). */
		const SESSION_MAX_AGE_CHOICES = [
			3,
			7,
			14,
			30,
			60,
			90,
			180
		];
		//#endregion
		//#region src/client/index.tsx
		/**
		* Service required before the section can be registered. The settings
		* section ledger is contributed by the settings shell (`settings.section`
		* slot declaration); the bundle-load order is not a timing guarantee, so the
		* registration waits on the `slots` service instead.
		*
		* Note (0.1.2): the rc.8-0.1.1 `connection.isLoopback` override (both the
		* node-half tapIndex hook and this plugin's defensive re-apply) is GONE.
		* Upstream's real cookie authentication lets a remote browser into the UI,
		* but ui-settings still builds its settings mirror from
		* `connection.isLoopback` (`location.hostname`), so LAN browsers get a
		* `memory` mirror whose Models section reports "settings are unavailable in
		* this browser". The tapIndex hook sets `window.__DSH_TRANSPORT__` with
		* `ownsHost: true` instead — that makes connection report loopback without
		* rewriting the cordis service. No mirror guard is needed here.
		*/
		const inject = ["slots"];
		/** Stable registration id inside the settings section list. */
		const SECTION_ID = "auth";
		/** Nav label, and the only DOM-visible identity of our nav row (see installAuthNavIcon). */
		const SECTION_LABEL = "认证";
		/** Marks a nav row whose glyph was already swapped, so neither React nor the observer loops. */
		const GLYPH_ATTR = "data-dsh-auth-nav-icon";
		/** Shield + check glyph, drawn in the shell's idiom: 16px grid, currentColor, no fill. */
		const SHIELD_GLYPH_MARKUP = "<svg viewBox=\"0 0 16 16\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M8 1.4 L13.6 3.35 V7.9 C13.6 11.1 11.3 13.45 8 14.6 C4.7 13.45 2.4 11.1 2.4 7.9 V3.35 Z\" stroke=\"currentColor\" stroke-width=\"1.3\" stroke-linejoin=\"round\" /><path d=\"M5.3 7.9 L7.3 9.9 L10.8 6.2\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\" /></svg>";
		/** How long a status/action message stays visible. */
		const MESSAGE_MS = 5e3;
		/** The username shown in the tab (undefined until the status fetch resolves). */
		function useUsername() {
			const [username, setUsername] = (0, react.useState)(void 0);
			(0, react.useEffect)(() => {
				let cancelled = false;
				(async () => {
					try {
						const res = await fetch("/api/auth/status");
						if (!res.ok) return;
						const data = await res.json();
						if (!cancelled && typeof data.username === "string") setUsername(data.username);
					} catch {}
				})();
				return () => {
					cancelled = true;
				};
			}, []);
			return [username, setUsername];
		}
		/**
		* Tracks the "本机登录校验" switch shown in the tab. This maps 1:1 to the
		* backend flag `requireLoopbackLogin` (no inversion): ON = the loopback
		* address is also required to present a session. OUT OF THE BOX it is OFF
		* (loopback trusted = 本机免登录); it only flips ON on an explicit admin
		* action (e.g. a shared multi-user server).
		*/
		function useLoopbackLoginCheck() {
			const [loopbackLoginCheck, setLoopbackLoginCheck] = (0, react.useState)(false);
			(0, react.useEffect)(() => {
				let cancelled = false;
				(async () => {
					try {
						const res = await fetch("/api/auth/policy");
						if (!res.ok) return;
						const data = await res.json();
						if (!cancelled && typeof data.requireLoopbackLogin === "boolean") setLoopbackLoginCheck(data.requireLoopbackLogin === true);
					} catch {}
				})();
				return () => {
					cancelled = true;
				};
			}, []);
			return [loopbackLoginCheck, setLoopbackLoginCheck];
		}
		/**
		* Tracks the "会话有效期" selection shown in the tab. Maps to the persisted
		* `sessionMaxAgeDays` (see session-limits.ts for the selectable choices);
		* OUT OF THE BOX it is the 14-day default. Changing it only affects freshly
		* issued sessions — existing cookies keep the expiry baked in at sign time.
		*/
		function useSessionMaxAge() {
			const [days, setDays] = (0, react.useState)(14);
			(0, react.useEffect)(() => {
				let cancelled = false;
				(async () => {
					try {
						const res = await fetch("/api/auth/session-max-age");
						if (!res.ok) return;
						const data = await res.json();
						if (!cancelled && typeof data.days === "number") setDays(data.days);
					} catch {}
				})();
				return () => {
					cancelled = true;
				};
			}, []);
			return [days, setDays];
		}
		/**
		* Replace the settings nav's default gear for our row with the shield glyph.
		* Identity comes from the label text because the row button carries no id
		* attribute (React's `key` never reaches the DOM). Geometry and class are
		* copied off the gear so the shell's `.navIcon { flex: none }` sizing and the
		* currentColor nav tint keep working.
		*/
		function swapNavGlyph() {
			if (document.querySelector(`[${GLYPH_ATTR}]`)) return;
			for (const label of document.querySelectorAll("nav button span")) {
				if (label.textContent?.trim() !== SECTION_LABEL) continue;
				const button = label.closest("button");
				const gear = button?.querySelector("svg");
				if (!button || !gear || button.hasAttribute(GLYPH_ATTR)) continue;
				button.setAttribute(GLYPH_ATTR, "1");
				const holder = document.createElement("template");
				holder.innerHTML = SHIELD_GLYPH_MARKUP;
				const glyph = holder.content.firstElementChild;
				if (glyph === null) return;
				for (const attr of [
					"width",
					"height",
					"class"
				]) {
					const value = gear.getAttribute(attr);
					if (value !== null) glyph.setAttribute(attr, value);
				}
				glyph.setAttribute("aria-hidden", "true");
				gear.replaceWith(glyph);
				return;
			}
		}
		/**
		* The settings shell chooses nav glyphs from a hardcoded if-chain over the
		* section id (`ui-settings-general`'s `navIcon`), and the `settings.section`
		* slot spec carries only `{ id, order, label }` — a registrant cannot ship an
		* icon, so "认证" lands on the fallback gear. Swapping it in the DOM is the
		* only plugin-side route: the panel unmounts on close, so an observer keeps
		* re-applying on every mount, and a row that stops matching simply keeps the
		* gear (cosmetic failure only, never a broken panel).
		*/
		function installAuthNavIcon() {
			if (typeof document === "undefined") return;
			let queued = false;
			const schedule = () => {
				if (queued) return;
				queued = true;
				requestAnimationFrame(() => {
					queued = false;
					swapNavGlyph();
				});
			};
			new MutationObserver(schedule).observe(document.body, {
				childList: true,
				subtree: true
			});
			schedule();
		}
		/**
		* The settings tab content. Sign-out navigates back to the login page;
		* change-username / change-password post to the auth endpoints and show the
		* outcome inline.
		*/
		function AuthSection(props) {
			const [username, setUsername] = useUsername();
			const [loopbackLoginCheck, setLoopbackLoginCheck] = useLoopbackLoginCheck();
			const [sessionMaxAgeDays, setSessionMaxAgeDays] = useSessionMaxAge();
			const [newUsername, setNewUsername] = (0, react.useState)("");
			const [usernamePassword, setUsernamePassword] = (0, react.useState)("");
			const [oldPassword, setOldPassword] = (0, react.useState)("");
			const [newPassword, setNewPassword] = (0, react.useState)("");
			const [confirm, setConfirm] = (0, react.useState)("");
			const [busy, setBusy] = (0, react.useState)(false);
			const [notice, setNotice] = (0, react.useState)(void 0);
			const [confirmingSignOut, setConfirmingSignOut] = (0, react.useState)(false);
			/** Which edit form (if any) is expanded; both start collapsed. */
			const [expanded, setExpanded] = (0, react.useState)(null);
			const flash = (0, react.useCallback)((notice) => {
				setNotice(notice);
				if (notice !== void 0) setTimeout(() => setNotice(void 0), MESSAGE_MS);
			}, []);
			const signOut = (0, react.useCallback)(async () => {
				setBusy(true);
				try {
					await fetch("/api/auth/logout", { method: "POST" });
					window.location.href = "/login";
				} catch {
					setBusy(false);
					setConfirmingSignOut(false);
					flash({
						kind: "error",
						text: "退出失败，请重试",
						owner: "account"
					});
				}
			}, [flash]);
			const changePassword = (0, react.useCallback)(async () => {
				if (newPassword !== confirm) {
					flash({
						kind: "error",
						text: "两次输入的新密码不一致",
						owner: "password"
					});
					return;
				}
				setBusy(true);
				try {
					const res = await fetch("/api/auth/change-password", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							oldPassword,
							newPassword
						})
					});
					const data = await res.json();
					if (res.ok) {
						setOldPassword("");
						setNewPassword("");
						setConfirm("");
						flash({
							kind: "ok",
							text: "密码已修改",
							owner: "password"
						});
					} else flash({
						kind: "error",
						text: data.error ?? "修改失败，请重试",
						owner: "password"
					});
				} catch {
					flash({
						kind: "error",
						text: "修改失败，请重试",
						owner: "password"
					});
				} finally {
					setBusy(false);
				}
			}, [
				oldPassword,
				newPassword,
				confirm,
				flash
			]);
			const toggleLoopbackLoginCheck = (0, react.useCallback)(async (next) => {
				setBusy(true);
				try {
					const res = await fetch("/api/auth/policy", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ requireLoopbackLogin: next })
					});
					const data = await res.json();
					if (res.ok) {
						setLoopbackLoginCheck(data.requireLoopbackLogin === true);
						flash({
							kind: "ok",
							text: next ? "已启用：本机地址将要求登录" : "已关闭：本机访问免登录",
							owner: "policy"
						});
					} else flash({
						kind: "error",
						text: data.error ?? "修改失败，请重试",
						owner: "policy"
					});
				} catch {
					flash({
						kind: "error",
						text: "修改失败，请重试",
						owner: "policy"
					});
				} finally {
					setBusy(false);
				}
			}, [flash, setLoopbackLoginCheck]);
			/** Persists the selected session lifetime immediately on change (mirrors
			* the policy toggle: load via hook, save on interaction, flash the outcome). */
			const saveSessionMaxAge = (0, react.useCallback)(async (next) => {
				setBusy(true);
				try {
					const res = await fetch("/api/auth/session-max-age", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ days: next })
					});
					const data = await res.json();
					if (res.ok) {
						if (typeof data.days === "number") setSessionMaxAgeDays(data.days);
						flash({
							kind: "ok",
							text: `已保存：会话有效期 ${next} 天（对新登录的会话生效）`,
							owner: "sessionMaxAge"
						});
					} else flash({
						kind: "error",
						text: data.error ?? "修改失败，请重试",
						owner: "sessionMaxAge"
					});
				} catch {
					flash({
						kind: "error",
						text: "修改失败，请重试",
						owner: "sessionMaxAge"
					});
				} finally {
					setBusy(false);
				}
			}, [flash, setSessionMaxAgeDays]);
			const changeUsername = (0, react.useCallback)(async () => {
				setBusy(true);
				try {
					const res = await fetch("/api/auth/change-username", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							newUsername,
							currentPassword: usernamePassword
						})
					});
					const data = await res.json();
					if (res.ok) {
						setNewUsername("");
						setUsernamePassword("");
						if (typeof data.username === "string") setUsername(data.username);
						flash({
							kind: "ok",
							text: "用户名已更新",
							owner: "username"
						});
					} else flash({
						kind: "error",
						text: data.error ?? "修改失败，请重试",
						owner: "username"
					});
				} catch {
					flash({
						kind: "error",
						text: "修改失败，请重试",
						owner: "username"
					});
				} finally {
					setBusy(false);
				}
			}, [
				newUsername,
				usernamePassword,
				flash,
				setUsername
			]);
			const inputStyle = {
				width: "100%",
				boxSizing: "border-box",
				padding: "8px 10px",
				border: "1px solid #d9d9d9",
				borderRadius: 6,
				fontSize: 14,
				fontFamily: "inherit"
			};
			const buttonStyle = {
				padding: "8px 16px",
				borderRadius: 6,
				fontSize: 14,
				fontFamily: "inherit",
				cursor: "pointer",
				border: "1px solid transparent"
			};
			/** Card wrapper so the four settings blocks read as visually distinct units. */
			const cardStyle = {
				border: "1px solid #e5e5e5",
				borderRadius: 10,
				padding: "18px 20px",
				background: "#ffffff",
				boxShadow: "0 1px 2px rgba(0, 0, 0, 0.04)"
			};
			/** Text-button look used to expand/collapse the username / password forms. */
			const linkStyle = {
				background: "none",
				border: "none",
				color: "#4d6bfe",
				fontSize: 13,
				cursor: "pointer",
				padding: 0,
				fontFamily: "inherit"
			};
			/** Accordion chevron drawn as a symmetric SVG so it rotates about its true
			* visual center (a border-drawn chevron's mass sits at the corner, which
			* drifts when rotated around the box center). */
			const Chevron = ({ up }) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
				width: 14,
				height: 14,
				viewBox: "0 0 14 14",
				"aria-hidden": true,
				style: {
					transform: up ? "rotate(180deg)" : "rotate(0deg)",
					transition: "transform 0.2s ease",
					transformOrigin: "center"
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: "M3 5 L7 9 L11 5",
					fill: "none",
					stroke: "#333",
					strokeWidth: 2,
					strokeLinecap: "round",
					strokeLinejoin: "round"
				})
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					flexDirection: "column",
					gap: 16,
					maxWidth: 460
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						style: cardStyle,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
								style: {
									fontSize: 16,
									fontWeight: 600,
									margin: "0 0 4px"
								},
								children: "账号"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: {
									fontSize: 13,
									color: "#666",
									margin: "0 0 12px"
								},
								children: username !== void 0 ? `当前登录：${username}` : "当前登录：管理员"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									position: "relative",
									display: "inline-block"
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									onClick: () => setConfirmingSignOut(true),
									disabled: busy,
									style: {
										...buttonStyle,
										background: "none",
										borderColor: "#d4380d",
										color: "#d4380d"
									},
									children: "退出登录"
								}), confirmingSignOut && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									role: "alertdialog",
									"aria-label": "确认退出登录",
									style: {
										position: "absolute",
										top: "calc(100% + 10px)",
										left: 0,
										zIndex: 10,
										minWidth: 260,
										padding: "12px 14px",
										background: "#ffffff",
										border: "1px solid #e5e5e5",
										borderRadius: 8,
										boxShadow: "0 4px 12px rgba(0, 0, 0, 0.12)"
									},
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											"aria-hidden": true,
											style: {
												position: "absolute",
												top: -6,
												left: 28,
												width: 10,
												height: 10,
												background: "#ffffff",
												borderLeft: "1px solid #e5e5e5",
												borderTop: "1px solid #e5e5e5",
												transform: "rotate(45deg)"
											}
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											style: {
												fontSize: 13,
												color: "#333",
												marginBottom: 10
											},
											children: "退出登录将回到登录页"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											style: {
												display: "flex",
												justifyContent: "flex-end",
												gap: 8
											},
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												onClick: () => setConfirmingSignOut(false),
												disabled: busy,
												style: {
													...buttonStyle,
													padding: "4px 12px",
													background: "none",
													borderColor: "#d9d9d9",
													color: "#333"
												},
												children: "取消"
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												onClick: () => void signOut(),
												disabled: busy,
												style: {
													...buttonStyle,
													padding: "4px 12px",
													background: "#d4380d",
													color: "#ffffff"
												},
												children: "确认退出"
											})]
										})
									]
								})]
							}),
							notice?.owner === "account" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: {
									fontSize: 13,
									color: notice.kind === "ok" ? "#237804" : "#d4380d",
									margin: "8px 0 0"
								},
								children: notice.text
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						style: cardStyle,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									display: "flex",
									alignItems: "center",
									justifyContent: "space-between"
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
									style: {
										fontSize: 16,
										fontWeight: 600,
										margin: 0
									},
									children: "修改用户名"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									onClick: () => setExpanded(expanded === "username" ? null : "username"),
									disabled: busy,
									"aria-label": expanded === "username" ? "收起" : "修改用户名",
									"aria-expanded": expanded === "username",
									style: {
										...linkStyle,
										padding: 12,
										margin: -12,
										display: "inline-flex",
										alignItems: "center",
										justifyContent: "center"
									},
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chevron, { up: expanded === "username" })
								})]
							}),
							expanded === "username" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
								onSubmit: (event) => {
									event.preventDefault();
									changeUsername();
								},
								style: {
									display: "flex",
									flexDirection: "column",
									gap: 12,
									marginTop: 12
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										style: {
											display: "flex",
											flexDirection: "column",
											gap: 4,
											fontSize: 13
										},
										children: ["新用户名", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											type: "text",
											value: newUsername,
											onChange: (event) => setNewUsername(event.target.value),
											autoComplete: "username",
											style: inputStyle
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										style: {
											display: "flex",
											flexDirection: "column",
											gap: 4,
											fontSize: 13
										},
										children: ["当前密码", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											type: "password",
											value: usernamePassword,
											onChange: (event) => setUsernamePassword(event.target.value),
											autoComplete: "current-password",
											style: inputStyle
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										style: {
											display: "flex",
											alignItems: "center",
											gap: 12
										},
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "submit",
											disabled: busy,
											style: {
												...buttonStyle,
												background: "#4d6bfe",
												color: "#ffffff"
											},
											children: "修改用户名"
										})
									})
								]
							}),
							notice?.owner === "username" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: {
									fontSize: 13,
									color: notice.kind === "ok" ? "#237804" : "#d4380d",
									margin: expanded === "username" ? "12px 0 0" : "8px 0 0"
								},
								children: notice.text
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						style: cardStyle,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									display: "flex",
									alignItems: "center",
									justifyContent: "space-between"
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
									style: {
										fontSize: 16,
										fontWeight: 600,
										margin: 0
									},
									children: "修改密码"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									onClick: () => setExpanded(expanded === "password" ? null : "password"),
									disabled: busy,
									"aria-label": expanded === "password" ? "收起" : "修改密码",
									"aria-expanded": expanded === "password",
									style: {
										...linkStyle,
										padding: 12,
										margin: -12,
										display: "inline-flex",
										alignItems: "center",
										justifyContent: "center"
									},
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chevron, { up: expanded === "password" })
								})]
							}),
							expanded === "password" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
								onSubmit: (event) => {
									event.preventDefault();
									changePassword();
								},
								style: {
									display: "flex",
									flexDirection: "column",
									gap: 12,
									marginTop: 12
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										style: {
											display: "flex",
											flexDirection: "column",
											gap: 4,
											fontSize: 13
										},
										children: ["当前密码", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											type: "password",
											value: oldPassword,
											onChange: (event) => setOldPassword(event.target.value),
											autoComplete: "current-password",
											style: inputStyle
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										style: {
											display: "flex",
											flexDirection: "column",
											gap: 4,
											fontSize: 13
										},
										children: ["新密码", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											type: "password",
											value: newPassword,
											onChange: (event) => setNewPassword(event.target.value),
											autoComplete: "new-password",
											style: inputStyle
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										style: {
											display: "flex",
											flexDirection: "column",
											gap: 4,
											fontSize: 13
										},
										children: ["确认新密码", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											type: "password",
											value: confirm,
											onChange: (event) => setConfirm(event.target.value),
											autoComplete: "new-password",
											style: inputStyle
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										style: {
											display: "flex",
											alignItems: "center",
											gap: 12
										},
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "submit",
											disabled: busy,
											style: {
												...buttonStyle,
												background: "#4d6bfe",
												color: "#ffffff"
											},
											children: "修改密码"
										})
									})
								]
							}),
							notice?.owner === "password" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: {
									fontSize: 13,
									color: notice.kind === "ok" ? "#237804" : "#d4380d",
									margin: expanded === "password" ? "12px 0 0" : "8px 0 0"
								},
								children: notice.text
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						style: cardStyle,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
								style: {
									fontSize: 16,
									fontWeight: 600,
									margin: "0 0 4px"
								},
								children: "登录要求"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: {
									fontSize: 13,
									color: "#666",
									margin: "0 0 12px"
								},
								children: "若启用，本机地址将要求登录，建议在多人共享服务器、需禁止同机其他账号免登录时启用。"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								style: {
									display: "inline-flex",
									alignItems: "center",
									gap: 8,
									cursor: "pointer",
									fontSize: 13
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									style: {
										position: "relative",
										width: 40,
										height: 22,
										borderRadius: 11,
										background: loopbackLoginCheck ? "#4d6bfe" : "#c4c4c4",
										transition: "background 0.2s",
										flexShrink: 0
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "checkbox",
										checked: loopbackLoginCheck,
										disabled: busy,
										onChange: (event) => void toggleLoopbackLoginCheck(event.target.checked),
										style: {
											position: "absolute",
											inset: 0,
											margin: 0,
											width: "100%",
											height: "100%",
											opacity: 0,
											cursor: "pointer"
										}
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: {
										position: "absolute",
										top: 2,
										left: loopbackLoginCheck ? 20 : 2,
										width: 18,
										height: 18,
										borderRadius: "50%",
										background: "#ffffff",
										transition: "left 0.2s",
										boxShadow: "0 1px 2px rgba(0, 0, 0, 0.2)"
									} })]
								}), "本机登录校验"]
							}),
							notice?.owner === "policy" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: {
									fontSize: 13,
									color: notice.kind === "ok" ? "#237804" : "#d4380d",
									margin: "8px 0 0"
								},
								children: notice.text
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						style: cardStyle,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
								style: {
									fontSize: 16,
									fontWeight: 600,
									margin: "0 0 4px"
								},
								children: "会话有效期"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: {
									fontSize: 13,
									color: "#666",
									margin: "0 0 12px"
								},
								children: "登录后会话 cookie 的有效天数。调整后对新登录的会话生效，已登录的会话不受影响。"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								style: {
									display: "inline-flex",
									alignItems: "center",
									gap: 8,
									fontSize: 13
								},
								children: ["有效期", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
									value: sessionMaxAgeDays,
									disabled: busy,
									onChange: (event) => void saveSessionMaxAge(Number(event.target.value)),
									style: {
										...inputStyle,
										width: "auto"
									},
									children: SESSION_MAX_AGE_CHOICES.map((days) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
										value: days,
										children: [days, " 天"]
									}, days))
								})]
							}),
							notice?.owner === "sessionMaxAge" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: {
									fontSize: 13,
									color: notice.kind === "ok" ? "#237804" : "#d4380d",
									margin: "8px 0 0"
								},
								children: notice.text
							})
						]
					})
				]
			});
		}
		/**
		* Register the auth section once the `settings.section` declaration is on
		* the ledger. The label is a plain string (no locale dependency).
		*
		* Note: 0.1.2 dropped the client-runtime aggregate type and the `slots`
		* Context member is not re-declared by any package we depend on, so the
		* service is read through a narrow structural assertion (cordis proxies the
		* property at runtime; the `inject` set above is what guarantees it).
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			const slots = ctx.slots;
			slots?.inject("settings.section", () => slots.register({
				name: "settings.section",
				id: SECTION_ID,
				order: 100,
				label: () => SECTION_LABEL
			}, AuthSection));
			installAuthNavIcon();
		}
		//#endregion
		exports.AuthSection = AuthSection;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map