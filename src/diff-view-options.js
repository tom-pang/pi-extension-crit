import { critDiffOptions } from "./diff-options.js";

export function buildDiffViewOptions({ splitView, onGutterUtilityClick }) {
  return {
    ...critDiffOptions,
    diffStyle: splitView ? "split" : "unified",
    enableGutterUtility: true,
    onGutterUtilityClick,
  };
}
