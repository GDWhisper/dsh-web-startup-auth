import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The `@deepseek-ai/dsh` peer range is this plugin's version gate: dsh's
 * plugin loader (`plugin-compatibility.ts`) evaluates exactly these fields and
 * SKIPS the bundle (with a loud diagnostic) when the running dsh falls outside
 * the range. The spellings below are load-bearing — see the assertions.
 */
describe('package manifest version gate', () => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as {
    peerDependencies?: Record<string, string>
    peerDependenciesMeta?: Record<string, { optional?: boolean }>
  }

  it('declares the supported dsh range as a peer', () => {
    expect(manifest.peerDependencies?.['@deepseek-ai/dsh']).toBe('>=0.1.7-rc.1 <0.3.0-0')
  })

  it('keeps the -0 upper bound (bare <0.3.0 would admit 0.3.0 rc releases)', () => {
    // The loader evaluates with semver includePrerelease: true, where
    // `<0.3.0` matches 0.3.0-rc.1 — the exact version line the gate exists to
    // refuse. The `-0` suffix sorts before every prerelease identifier
    // (numeric identifiers have the lowest precedence), so `<0.3.0-0` refuses
    // the whole 0.3 line including its release candidates. Verified against
    // the semver copy shipped inside the dsh CLI at the 0.2.0-rc.1 review.
    // Re-verify against the loader's actual semver with:
    //   node -e "const s=require('semver'); console.log(s.satisfies('0.3.0-rc.1','<0.3.0',{includePrerelease:true}), s.satisfies('0.3.0-rc.1','<0.3.0-0',{includePrerelease:true}))"
    // (expected output: true false)
    expect(manifest.peerDependencies?.['@deepseek-ai/dsh']).toContain('<0.3.0-0')
    expect(manifest.peerDependencies?.['@deepseek-ai/dsh']).not.toMatch(/<0\.3\.0$/)
  })

  it('marks the dsh peer optional (no package manager may auto-install the CLI)', () => {
    // Without `optional: true`, npm 7+/pnpm 8+ auto-install peer dependencies
    // and would drag the whole `@deepseek-ai/dsh` CLI (500+ packages) into
    // every profile that installs this plugin. The loader reads only
    // `peerDependencies`, so the meta flag does not weaken the gate.
    expect(manifest.peerDependenciesMeta?.['@deepseek-ai/dsh']?.optional).toBe(true)
  })
})
