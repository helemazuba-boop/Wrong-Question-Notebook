import 'server-only';

import {
  default_w,
  FSRSVersion,
  generatorParameters,
  type FSRSParameters as RuntimeFsrsParameters,
} from 'ts-fsrs';
import { FsrsParametersSchema, type FsrsParameters } from '@/lib/fsrs/schemas';

export const FSRS_LIBRARY_NAME = 'ts-fsrs' as const;
export const FSRS_LIBRARY_VERSION = '5.4.1' as const;
export const FSRS_ALGORITHM_VERSION = 'FSRS-6.0' as const;
export const FSRS_RUNTIME_VERSION =
  `${FSRS_LIBRARY_NAME}@${FSRS_LIBRARY_VERSION} using ${FSRS_ALGORITHM_VERSION}` as const;

const EXPECTED_UPSTREAM_VERSION = `v${FSRS_LIBRARY_VERSION} using ${FSRS_ALGORITHM_VERSION}`;

if (FSRSVersion !== EXPECTED_UPSTREAM_VERSION) {
  throw new Error(
    `Unsupported FSRS runtime: expected ${EXPECTED_UPSTREAM_VERSION}, received ${FSRSVersion}`
  );
}

if (default_w.length !== 21) {
  throw new Error(
    `Unsupported FSRS parameter count: expected 21, received ${default_w.length}`
  );
}

const baselineParameters = FsrsParametersSchema.parse({
  request_retention: 0.9,
  maximum_interval: 36500,
  w: [...default_w],
  enable_fuzz: false,
  enable_short_term: false,
  learning_steps: [],
  relearning_steps: [],
});

Object.freeze(baselineParameters.w);
Object.freeze(baselineParameters.learning_steps);
Object.freeze(baselineParameters.relearning_steps);

export const FSRS_BASELINE_PARAMETERS: Readonly<FsrsParameters> =
  Object.freeze(baselineParameters);

export function parseFsrsParameters(value: unknown): FsrsParameters {
  return FsrsParametersSchema.parse(value);
}

export function toRuntimeFsrsParameters(value: unknown): RuntimeFsrsParameters {
  const parameters = parseFsrsParameters(value);
  const runtime = generatorParameters(parameters);

  if (
    runtime.w.length !== parameters.w.length ||
    runtime.w.some((weight, index) => weight !== parameters.w[index])
  ) {
    throw new Error(
      'FSRS runtime changed the supplied 21-weight parameter set'
    );
  }

  return runtime;
}

export interface FsrsRuntimeProvenance {
  algorithm_version: typeof FSRS_ALGORITHM_VERSION;
  library_name: typeof FSRS_LIBRARY_NAME;
  library_version: typeof FSRS_LIBRARY_VERSION;
  runtime_version: typeof FSRS_RUNTIME_VERSION;
}

export const FSRS_RUNTIME_PROVENANCE: FsrsRuntimeProvenance = Object.freeze({
  algorithm_version: FSRS_ALGORITHM_VERSION,
  library_name: FSRS_LIBRARY_NAME,
  library_version: FSRS_LIBRARY_VERSION,
  runtime_version: FSRS_RUNTIME_VERSION,
});
