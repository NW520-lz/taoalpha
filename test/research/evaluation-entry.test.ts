import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {runCli,type CliDeps} from '../../src/cli.ts';
import {createResearchMcpServer} from '../../src/mcp/research-server.ts';
import {runFinalEvaluation} from '../../src/research/final-evaluation.ts';
import {createFakeClient} from '../helpers/fake-okx.ts';
import {marketRoutes} from '../helpers/market-fixtures.ts';
import {expected,ohlc,setup,windowsAt,now} from '../helpers/experiment-fixtures.ts';

const gates={minRealizedTrades:1,maxValidationDecay:'0.4',normalizationDays:1,requirePositiveNet:true,costStressMultipliers:[1,2],costStressMustStayPositiveAt:2,requireBeatHold:false,sensitivity:{neighbourhoods:{trailingStopAtr:['1.5','1.6']},maxAdjacentChange:'0.5',requireAllPositive:true}};
const reports=(deps:CliDeps)=>deps.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='final_evaluation_reports'").get()!.n ? deps.db.prepare('SELECT count(*) n FROM final_evaluation_reports').get()!.n : 0;

async function evaluated() {
 const {db,registry,input}=await setup([],ohlc);
 registry.register({...input,windows:windowsAt(6,9,12),gates});
 registry.register({...input,version:2,attemptId:'attempt:trend:2',windows:windowsAt(6,9,12),gates});
 const report=runFinalEvaluation(db,registry,{experimentId:'experiment:trend',version:1,expected},now);
 const deps:CliDeps={db,client:createFakeClient(marketRoutes()).client,now,defaultStrategyPath:'unused.json'};
 return {deps,report};
}

test('the CLI reads a stored final report and never runs one',async()=>{
 const {deps,report}=await evaluated();try {
  const found=await runCli(['research','evaluation','experiment:trend','1'],deps);
  assert.deepEqual([found.ok,(found.value as {state:string}).state,(found.value as {report:unknown}).report],[true,'evaluated',report]);
  const missing=await runCli(['research','evaluation','experiment:trend','2'],deps);
  assert.deepEqual([missing.ok,(missing.value as {state:string}).state,(missing.value as {report:unknown}).report],[true,'no_report',null]);
  assert.equal(reports(deps),1);
  const later=await runCli(['research','evaluation','experiment:trend','12'],deps);
  assert.deepEqual([later.ok,(later.value as {state:string}).state],[true,'no_report']);
  const bad=await runCli(['research','evaluation','experiment:trend','zero'],deps);
  assert.equal(bad.ok,false);
 }finally{deps.db.close()}
});

test('the MCP tool returns the same report read-only',async()=>{
 const {deps,report}=await evaluated();
 const server=createResearchMcpServer(deps), client=new Client({name:'synthetic-host',version:'1.0.0'});
 const [a,b]=InMemoryTransport.createLinkedPair();
 try {
  await server.connect(b);await client.connect(a);
  const tool=(await client.listTools()).tools.find(t=>t.name==='taoalpha_research_evaluation');
  assert.equal(tool?.annotations?.readOnlyHint,true);
  const result=await client.callTool({name:'taoalpha_research_evaluation',arguments:{experimentId:'experiment:trend',version:1}});
  assert.deepEqual((result.structuredContent as {value:{report:unknown}}).value.report,report);
  const none=await client.callTool({name:'taoalpha_research_evaluation',arguments:{experimentId:'experiment:trend',version:2}});
  assert.equal((none.structuredContent as {value:{state:string}}).value.state,'no_report');
  assert.equal(reports(deps),1);
 }finally{await client.close();await server.close();deps.db.close();}
});
