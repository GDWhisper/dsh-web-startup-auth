/**
 * Auth settings tab, browser half.
 *
 * Registers the "认证" section into the settings panel (`settings.section`
 * slot) with two actions: sign out and change password. Both ride the
 * existing `/api/auth/*` endpoints served by the node half (`src/auth.ts`);
 * the tab itself performs no RPC, so it depends only on the `slots` service.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { ReactElement } from 'react';
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
export declare const inject: string[];
/**
 * The settings tab content. Sign-out navigates back to the login page;
 * change-password posts to the auth endpoint and shows the outcome inline.
 */
export declare function AuthSection(props: PropsRuntime<'settings.section'>): ReactElement;
/**
 * Register the auth section once the `settings.section` declaration is on
 * the ledger. The label is a plain string (no locale dependency).
 * @param ctx - client root context.
 */
export declare function apply(ctx: ClientContext): void;
