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
/** Services required before the auth tab can be mounted. */
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
