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
  /**
   * How to use the plugin, in the author's own words.
   *
   * A context rule is invisible until something in the game matches it, so
   * "install it and see" is not a usable instruction. This is where an author
   * says what to do — dock somewhere with a Material Trader, prospect an
   * asteroid — so a commander can tell a working plugin from a quiet one.
   *
   * Rendered as plain text, never as HTML or Markdown. It comes from a
   * stranger, and text that can style itself is text that can misrepresent
   * itself as part of the application.
   */
  readonly instructions?: string;
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
  /**
   * Contents of an optional README.md beside the manifest.
   *
   * Longer than `instructions` and far nicer to write than a JSON string full
   * of escaped newlines. Also plain text on display, for the same reason.
   */
  readonly readme: string | null;
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
  /** Instructions are read, not scrolled through forever. */
  maxInstructionsChars: 4000,
  maxReadmeChars: 20_000,
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
