/**
 * Plugin manifests.
 *
 * A plugin is **data, not code**. There is deliberately no way to ship
 * JavaScript through this system, and no code path that would execute it if
 * you did: a plugin contributes declarative rules that the existing engines
 * already know how to evaluate.
 *
 * That is not a limitation working around effort — it is the reason the system
 * can be safe at all. `@edfm/context` conditions have a fixed operator set, no
 * `eval`, and deliberately no regular expressions, because they were built to
 * accept rules from an untrusted server. A third-party plugin is exactly that
 * same threat model, so the hardening already applies.
 *
 * What a plugin author writes is a JSON file. What the commander installs is a
 * folder. Nothing is compiled, nothing is fetched, and a malformed plugin
 * cannot take down the application or the other plugins.
 */

import type { ContextRule } from '@edfm/context';
import type { ResearchProject } from '@edfm/research';

/** Bumped when the manifest shape changes incompatibly. */
export const SUPPORTED_MANIFEST_VERSION = 1;

export interface PluginManifest {
  readonly manifestVersion: number;
  /**
   * Reverse-DNS style, e.g. `com.example.deep-core-mining`.
   *
   * Used to namespace everything the plugin contributes, so two plugins by
   * different authors cannot collide and neither can shadow a built-in rule.
   */
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly author?: string;
  readonly description?: string;
  readonly homepage?: string;
  readonly contributes: PluginContributions;
}

export interface PluginContributions {
  readonly contextRules?: readonly ContextRule[];
  readonly researchProjects?: readonly ResearchProject[];
}

/** Why a plugin was refused. Shown to the commander verbatim. */
export interface PluginProblem {
  readonly severity: 'error' | 'warning';
  readonly message: string;
}

export interface LoadedPlugin {
  readonly manifest: PluginManifest;
  /** Folder name on disk, so the commander can find the one that misbehaved. */
  readonly directory: string;
  readonly contextRules: readonly ContextRule[];
  readonly researchProjects: readonly ResearchProject[];
  /** Non-fatal complaints: the plugin loaded, but something was dropped. */
  readonly warnings: readonly string[];
}

export interface RejectedPlugin {
  readonly directory: string;
  /** Null when the manifest was too broken to name itself. */
  readonly id: string | null;
  readonly problems: readonly PluginProblem[];
}

export interface PluginLoadResult {
  readonly loaded: readonly LoadedPlugin[];
  readonly rejected: readonly RejectedPlugin[];
}

/**
 * Bounds, because a plugin folder is user-supplied input.
 *
 * A plugin with fifty thousand rules is not a feature request; it is a way to
 * make the context resolver take a second on every journal line.
 */
export const PLUGIN_LIMITS = {
  maxPlugins: 50,
  maxContextRulesPerPlugin: 200,
  maxResearchProjectsPerPlugin: 10,
  maxManifestBytes: 512 * 1024,
} as const;

/**
 * Journal events a plugin-supplied research project may not observe.
 *
 * §21 names what must never be collected: chat, friends, private groups, and
 * commander history unrelated to the active feature. The application honours
 * that; a plugin able to define its own observation rules could quietly write
 * chat messages into the local database and undo it.
 *
 * So this is a denylist rather than guidance. It is deliberately about the
 * *event*, not the field: `ReceiveText` has no safe subset worth the risk of
 * getting the path matching subtly wrong.
 */
export const FORBIDDEN_OBSERVATION_EVENTS: readonly string[] = [
  'ReceiveText',
  'SendText',
  'Friends',
  'WingAdd',
  'WingJoin',
  'WingInvite',
  'CrewMemberJoins',
  'CrewMemberQuits',
  'CrewHire',
  'SquadronStartup',
  'JoinACrew',
  'InvitedToSquadron',
  'AppliedToSquadron',
  'Commander',
  'LoadGame',
  'Statistics',
  'Powerplay',
];
