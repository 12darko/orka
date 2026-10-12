import { deleteFileTool, editFileTool, listDirectoryTool, readFileTool, writeFileTool } from './FileTools';
import { gitBranchTool, gitDiffTool, gitLogTool, gitStatusTool } from './GitTools';
import { updatePlanTool } from './PlanTools';
import { searchCodeTool, searchFilesTool } from './SearchTools';
import { runCommandTool } from './TerminalTools';
import type { Tool } from './Tool';
import { browserTool } from './BrowserTools';
import { codeOutlineTool } from './OutlineTools';
import { processOutputTool, startProcessTool, stopProcessTool } from './ProcessTools';
import { openBrowserTool, openFileTool, webFetchTool } from './WebTools';

export * from './Tool';
export { htmlToText } from './WebTools';
export { isViewableFile } from './workspace';
export { outlineText } from './OutlineTools';
export { applyEdit } from './FileTools';
export { runGit } from './GitTools';
export { stripAnsi } from './TerminalTools';
export { globToRegExp, IGNORED_DIRS, resolveInWorkspace, toRelative, walkFiles } from './workspace';

/**
 * The default tool set, in a fixed order. The tool list must stay identical for the whole
 * conversation (prompt caching and preserved thinking both depend on a stable prefix), so the
 * permission mode never adds or removes tools - it only changes what needs approval.
 */
export function defaultTools(): Tool[] {
  return [
    readFileTool,
    listDirectoryTool,
    searchFilesTool,
    searchCodeTool,
    codeOutlineTool,
    writeFileTool,
    editFileTool,
    deleteFileTool,
    runCommandTool,
    startProcessTool,
    processOutputTool,
    stopProcessTool,
    gitStatusTool,
    gitDiffTool,
    gitLogTool,
    gitBranchTool,
    updatePlanTool,
    webFetchTool,
    openBrowserTool,
    browserTool,
    openFileTool,
  ];
}
