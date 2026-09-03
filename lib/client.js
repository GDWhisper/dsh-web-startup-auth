window.__ModuleLoader__.load({
	id: "dsh-web-startup-auth",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
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
		* The settings tab content. Sign-out navigates back to the login page;
		* change-username / change-password post to the auth endpoints and show the
		* outcome inline.
		*/
		function AuthSection(props) {
			const [username, setUsername] = useUsername();
			const [newUsername, setNewUsername] = (0, react.useState)("");
			const [usernamePassword, setUsernamePassword] = (0, react.useState)("");
			const [oldPassword, setOldPassword] = (0, react.useState)("");
			const [newPassword, setNewPassword] = (0, react.useState)("");
			const [confirm, setConfirm] = (0, react.useState)("");
			const [busy, setBusy] = (0, react.useState)(false);
			const [notice, setNotice] = (0, react.useState)(void 0);
			const [confirmingSignOut, setConfirmingSignOut] = (0, react.useState)(false);
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
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					flexDirection: "column",
					gap: 24,
					maxWidth: 420
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", { children: [
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
					] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
						style: {
							fontSize: 16,
							fontWeight: 600,
							margin: "0 0 12px"
						},
						children: "修改用户名"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
						onSubmit: (event) => {
							event.preventDefault();
							changeUsername();
						},
						style: {
							display: "flex",
							flexDirection: "column",
							gap: 12
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
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									display: "flex",
									alignItems: "center",
									gap: 12
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "submit",
									disabled: busy,
									style: {
										...buttonStyle,
										background: "#4d6bfe",
										color: "#ffffff"
									},
									children: "修改用户名"
								}), notice?.owner === "username" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										fontSize: 13,
										color: notice.kind === "ok" ? "#237804" : "#d4380d"
									},
									children: notice.text
								})]
							})
						]
					})] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
						style: {
							fontSize: 16,
							fontWeight: 600,
							margin: "0 0 12px"
						},
						children: "修改密码"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
						onSubmit: (event) => {
							event.preventDefault();
							changePassword();
						},
						style: {
							display: "flex",
							flexDirection: "column",
							gap: 12
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
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									display: "flex",
									alignItems: "center",
									gap: 12
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "submit",
									disabled: busy,
									style: {
										...buttonStyle,
										background: "#4d6bfe",
										color: "#ffffff"
									},
									children: "修改密码"
								}), notice?.owner === "password" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										fontSize: 13,
										color: notice.kind === "ok" ? "#237804" : "#d4380d"
									},
									children: notice.text
								})]
							})
						]
					})] })
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
				label: () => "认证"
			}, AuthSection));
		}
		//#endregion
		exports.AuthSection = AuthSection;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map