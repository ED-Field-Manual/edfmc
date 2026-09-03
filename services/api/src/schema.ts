/**
 * Request validation.
 *
 * Every bound here is deliberate. The client is untrusted, so "a string" and
 * "an array" are not specifications -- an unbounded array of unbounded strings
 * is a memory exhaustion endpoint with a JSON schema.
 */

import { z } from 'zod';

/** Frontier's ids are short. 64 is generous and still bounded. */
const token = z.string().min(1).max(64);
const name = z.string().min(1).max(128);
const bigintText = z.string().regex(/^\d{1,20}$/, 'must be a positive integer id');

export const stationObservationSchema = z.object({
  marketId: bigintText,
  stationName: name.nullable().default(null),
  stationType: token.nullable().default(null),
  systemName: name.nullable().default(null),
  systemAddress: bigintText.nullable().default(null),
  // Elite's largest station service list is well under 40 entries; 64 leaves
  // headroom for an update without leaving the endpoint open.
  servicesRaw: z.array(token).max(64).nullable().default(null),
  observedAt: z.string().datetime({ offset: true }),
  sourceEvent: token,
  // `file:byteOffset` — long enough for a journal filename plus an offset.
  sourceEventId: z.string().min(1).max(256),
  gameVersion: token.nullable().default(null),
  gameBuild: z.string().max(128).nullable().default(null),
  sessionKey: z.string().min(1).max(256),
});

export const identitySchema = z
  .object({
    mode: z.enum(['anonymous', 'commander']),
    // Present in both modes: independence scoring is meaningless without a
    // distinguisher, and the server stores a keyed hash rather than the value.
    fid: token.nullable().default(null),
    commanderName: name.nullable().default(null),
    journalFile: z.string().max(256).nullable().default(null),
  })
  .superRefine((value, ctx) => {
    if (value.mode === 'commander' && !value.commanderName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'commanderName is required when mode is "commander"',
        path: ['commanderName'],
      });
    }
  });

export const submissionSchema = z.object({
  observation: stationObservationSchema,
  identity: identitySchema,
  clientVersion: token.nullable().default(null),
  /**
   * What the client thought it found. Advisory only: it is stored for
   * diagnosis and never used to create a discrepancy, because a claim about
   * what the reference says is not the client's to make.
   */
  claimed: z.unknown().optional(),
});

export const marketSearchSchema = z.object({
  // Bounded like everything else the client sends: an unbounded commodity list
  // is a query planner denial-of-service with a JSON schema.
  commodities: z.array(z.string().regex(/^[a-z0-9_]{1,64}$/)).min(1).max(64),
  origin: z
    .object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() })
    .optional(),
  radiusLy: z.number().positive().max(1000).optional(),
  maxAgeSeconds: z.number().int().positive().max(30 * 24 * 3600).optional(),
  minStock: z.number().int().nonnegative().max(1_000_000).optional(),
  includeFleetCarriers: z.boolean().optional(),
  includePlanetary: z.boolean().optional(),
  limit: z.number().int().positive().max(200).optional(),
});

export const lookupSchema = z.object({
  marketIds: z.array(bigintText).min(1).max(200),
});

export type SubmissionBody = z.infer<typeof submissionSchema>;
export type LookupBody = z.infer<typeof lookupSchema>;
export type MarketSearchBody = z.infer<typeof marketSearchSchema>;
