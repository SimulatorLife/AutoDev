import { runProviderAgent } from "./src/cli/provider-agent.ts";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync } from "node:fs"; import path from "node:path";
const root=mkdtempSync("/tmp/arepro-"); const home=path.join(root,"home"), ch=path.join(home,".codex"), w=path.join(root,"w"); mkdirSync(ch,{recursive:true}); mkdirSync(w);
const env={...process.env,HOME:home,CODEX_HOME:ch,AUTODEV_PLAYTEST_ANALYSIS_MODE:"1",AUTODEV_PLAYTEST_ANALYST_HOME:home,AUTODEV_PLAYTEST_ANALYST_CODEX_HOME:ch,AUTODEV_PLAYTEST_ANALYST_SOURCE_HOME:"/Users/henrykirk",AUTODEV_PLAYTEST_ANALYST_SOURCE_CODEX_HOME:"/Users/henrykirk/.codex",AUTODEV_REPO_ROOT:"/Users/henrykirk/AutoDev",AUTODEV_MEMORY_MODE:"disabled"};
await runProviderAgent(["--role","playtest-analyst","--cwd",w,"--prompt","x"],env,{ensureRouter:async()=>{},runCodex:(b,args,e)=>{console.log(JSON.stringify(args.slice(0,-1),null,1));console.log("ENVKEYS",Object.keys(e).sort().join(","));return 0;}});
console.log(readdirSync(ch)); console.log(readFileSync(path.join(ch,"config.toml"),"utf8").split("\n").filter(l=>/mcp_servers|^\[/.test(l)).join("\n"));
