import { createDangerousV2OnlyOfficeAdapter } from "../adapters/dangerous-v2-onlyoffice.mjs";
import { createPlanoraFixedRegressionAdapter } from "../adapters/planora-fixed-regression.mjs";
import { createTechnicalSpecRewriteRegressionAdapter } from "../adapters/technical-spec-rewrite-regression.mjs";

/**
 * Compose only the independently configured regression sets. This keeps an
 * experimental console usable when the fixed Planora benchmark root is absent.
 */
export function fixedRegressionAdapters(env = process.env) {
  const adapters = [];
  if (env.AGENT_EVAL_FIXED_ROOT) adapters.push({
    id: "planora-fixed-regression",
    executorIds: ["planora-fixed-regression-v1"],
    adapter: createPlanoraFixedRegressionAdapter({ root: env.AGENT_EVAL_FIXED_ROOT }),
  });
  if (env.AGENT_EVAL_DANGEROUS_V2_ROOT) adapters.push({
    id: "dangerous-v2-onlyoffice-experiment",
    executorIds: ["dangerous-v2-onlyoffice-external-driver-v1"],
    adapter: createDangerousV2OnlyOfficeAdapter({ root: env.AGENT_EVAL_DANGEROUS_V2_ROOT }),
  });
  if (env.AGENT_EVAL_TECH_SPEC_REWRITE_ROOT) adapters.push({
    id: "technical-spec-rewrite-regression",
    executorIds: ["technical-spec-rewrite-regression-v1"],
    adapter: createTechnicalSpecRewriteRegressionAdapter({ sourceRoot: env.AGENT_EVAL_TECH_SPEC_REWRITE_ROOT }),
  });
  return adapters;
}
