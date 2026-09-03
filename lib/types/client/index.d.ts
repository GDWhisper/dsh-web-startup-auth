/**
 * Auth settings tab, browser half.
 *
 * Registers the "认证" section into the settings panel (`settings.section`
 * slot) with two actions: sign out and change password. Both ride the
 * existing `/api/auth/*` endpoints served by the node half (`src/auth.ts`);
 * the tab itself performs no RPC, so it depends only on the `slots` service.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { ReactElement } from 'react';
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
export declare const inject: string[];
/**
 * The settings tab content. Sign-out navigates back to the login page;
 * change-username / change-password post to the auth endpoints and show the
 * outcome inline.
 */
export declare function AuthSection(props: PropsRuntime<'settings.section'>): ReactElement;
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
export declare function apply(ctx: Context): void;
