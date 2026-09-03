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
		* Services required before the main body can be mounted. The PRIMARY timing
		* guarantee comes from the node half (`src/auth.ts`): a script injected into
		* the SPA index wraps `window.__ModuleLoader__.load` and flips
		* `connection.isLoopback` to true the moment the connection plugin's apply
		* returns — before cordis notifies any dependent fiber — so the settings
		* mirror and every scope are built in host mode regardless of this plugin's
		* own activation order (bundle loads finish out of order). This root plugin
		* still injects only `connection` and repeats the override as a defensive
		* layer: cordis activates a fiber as soon as its inject set is ready, and
		* connection is the earliest service in the boot graph, so this apply runs
		* early enough to matter even if the injected hook was ever lost.
		*/
		const inject = ["connection"];
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
		/** The switch state shown in the tab (false until the policy fetch resolves). */
		function useRequireLoopbackLogin() {
			const [requireLoopbackLogin, setRequireLoopbackLogin] = (0, react.useState)(false);
			(0, react.useEffect)(() => {
				let cancelled = false;
				(async () => {
					try {
						const res = await fetch("/api/auth/policy");
						if (!res.ok) return;
						const data = await res.json();
						if (!cancelled && typeof data.requireLoopbackLogin === "boolean") setRequireLoopbackLogin(data.requireLoopbackLogin);
					} catch {}
				})();
				return () => {
					cancelled = true;
				};
			}, []);
			return [requireLoopbackLogin, setRequireLoopbackLogin];
		}
		/**
		* The settings tab content. Sign-out navigates back to the login page;
		* change-username / change-password post to the auth endpoints and show the
		* outcome inline.
		*/
		function AuthSection(props) {
			const [username, setUsername] = useUsername();
			const [requireLoopbackLogin, setRequireLoopbackLogin] = useRequireLoopbackLogin();
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
			const toggleLoopbackLogin = (0, react.useCallback)(async (next) => {
				setBusy(true);
				try {
					const res = await fetch("/api/auth/policy", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ requireLoopbackLogin: next })
					});
					const data = await res.json();
					if (res.ok) {
						setRequireLoopbackLogin(data.requireLoopbackLogin === true);
						flash({
							kind: "ok",
							text: next ? "已开启：所有地址都需要登录" : "已关闭：本机访问免登录",
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
			}, [flash, setRequireLoopbackLogin]);
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
							children: "登录要求"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: {
								fontSize: 13,
								color: "#666",
								margin: "0 0 12px"
							},
							children: "开启后，任何地址（包括本机）访问都需要登录"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							style: {
								display: "flex",
								alignItems: "center",
								gap: 8,
								fontSize: 13
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "checkbox",
								checked: requireLoopbackLogin,
								disabled: busy,
								onChange: (event) => void toggleLoopbackLogin(event.target.checked)
							}), "所有地址都需要登录"]
						}),
						notice?.owner === "policy" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: {
								fontSize: 13,
								color: notice.kind === "ok" ? "#237804" : "#d4380d",
								margin: "8px 0 0"
							},
							children: notice.text
						})
					] }),
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
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			const connection = ctx.get("connection");
			if (connection !== void 0) Object.defineProperty(connection, "isLoopback", {
				configurable: true,
				get: () => true
			});
			ctx.plugin({
				inject: ["slots", "settingsScope"],
				apply: (sub) => {
					const mirror = sub.get("settingsScope")?.mirror;
					if (mirror !== void 0 && mirror.persistence === "memory" && typeof mirror.load === "function") {
						mirror.persistence = "host";
						mirror.load();
					}
					sub.slots.inject("settings.section", () => sub.slots.register({
						name: "settings.section",
						id: SECTION_ID,
						order: 100,
						label: () => "认证"
					}, AuthSection));
				}
			});
		}
		//#endregion
		exports.AuthSection = AuthSection;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map