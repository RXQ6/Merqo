import {existsSync} from 'node:fs';import {join} from 'node:path';
/** Native shell/code/MCP can bypass every application-level ledger check. Do not grant
 * those capabilities to general conversations inside a managed retail workspace,
 * even in Auto. Business UI workers have separate explicit authorization paths. */
const READ_ONLY_CONVERSATION_TOOLS=new Set(['Read','Glob','Grep','WebSearch','WebFetch','AskUserQuestion','TodoWrite']);
export function retailToolBoundary(toolName:string,workspaceRootPath:string|undefined):{allowed:false;reason:string}|null{
 if(!workspaceRootPath||!existsSync(join(workspaceRootPath,'retail','operations.sqlite')))return null;
 if(READ_ONLY_CONVERSATION_TOOLS.has(toolName))return null;
 return{allowed:false,reason:'当前经营空间的通用会话只允许读取。Auto、Shell、文件写入、代码执行和其他 MCP 不能取得经营写权限。请通过经营分析中的决策草稿、审批中心和执行记录处理经营变更；普通代码或文件编辑请使用独立的非经营空间。'};
}
