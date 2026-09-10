// Executed in the container only after a bounded graceful close fails.
// A PID file alone is not authority: verify executable, uid, daemon/session environment,
// and /proc start time before signalling the exact process and its captured descendants.
export const CANCEL_DAEMON_SCRIPT = String.raw`
const fs = require('node:fs');
const [pidFile, session] = process.argv.slice(1);
const sleep = ms => new Promise(r => setTimeout(r, ms));
function inspect(pid) {
  try {
    const raw = fs.readFileSync('/proc/'+pid+'/stat','utf8');
    const fields = raw.slice(raw.lastIndexOf(')')+2).split(' ');
    return {pid, ppid:Number(fields[1]), start:fields[19], state:fields[0]};
  } catch { return null; }
}
function same(p) { const now=inspect(p.pid); return now && now.start===p.start && now.state!=='Z'; }
async function settled(owned, deadline) { while (Date.now() < deadline) { if (!owned.some(same)) return true; await sleep(50); } return !owned.some(same); }
(async () => {
  let text;
  try { text=fs.readFileSync(pidFile,'utf8').trim(); } catch(e) { if(e.code==='ENOENT'){console.log('inactive');return;}throw e; }
  if(!/^[1-9][0-9]*$/.test(text)) throw Error('Invalid daemon PID');
  const pid=Number(text); const root=inspect(pid);
  if(!root || root.state==='Z'){ console.log('inactive');return; }
  if(fs.statSync('/proc/'+pid).uid!==process.getuid()) throw Error('Daemon uid mismatch');
  const exe=fs.readlinkSync('/proc/'+pid+'/exe');
  const env=Object.fromEntries(fs.readFileSync('/proc/'+pid+'/environ','utf8').split('\0').filter(Boolean).map(s=>{const i=s.indexOf('=');return [s.slice(0,i),s.slice(i+1)];}));
  if(!/agent-browser[^/]*$/.test(exe) || env.AGENT_BROWSER_DAEMON!=='1' || env.AGENT_BROWSER_SESSION!==session) throw Error('Daemon identity mismatch');
  const all=fs.readdirSync('/proc').filter(n=>/^[0-9]+$/.test(n)).map(Number).map(inspect).filter(Boolean);
  const owned=[root];const ids=new Set([pid]);
  for(let changed=true;changed;){changed=false;for(const p of all)if(ids.has(p.ppid)&&!ids.has(p.pid)){owned.push(p);ids.add(p.pid);changed=true;}}
  for(const p of [...owned].reverse()) if(same(p)) try{process.kill(p.pid,'SIGTERM');}catch(e){if(e.code!=='ESRCH')throw e;}
  if(await settled(owned, Date.now()+500)) { console.log('terminated-verified-session'); return; }
  for(const p of [...owned].reverse()) if(same(p)) try{process.kill(p.pid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')throw e;}
  if(await settled(owned, Date.now()+300)) { console.log('terminated-verified-session'); return; }
  throw Error('Session processes remain alive');
})().catch(e=>{console.error(e.message);process.exitCode=1;});
`;
export const CANCEL_SESSION_SCRIPT = `
lease="$1"; pidfile="$2"; sess="$3"; ns="$4"; staging="$5"; shift 5
# Stop the CLI process group recorded for this request, if any.
if [ -f "$lease" ]; then
  p=$(cat "$lease" 2>/dev/null || true)
  case "$p" in ""|*[!0-9]*) ;; *) if [ -r "/proc/$p/cmdline" ] && tr '\\0' ' ' < "/proc/$p/cmdline" | grep -q agent-browser; then kill -TERM -- "-$p" 2>/dev/null || true; fi;; esac
  rm -f -- "$lease"
fi
# A graceful close is only attempted while the recorded daemon is alive; otherwise it would start a
# brand-new daemon just to close it.
probe=$(cat "$pidfile" 2>/dev/null || true)
alive=0
case "$probe" in ""|*[!0-9]*) ;; *) [ -d "/proc/$probe" ] && alive=1;; esac
if [ "$alive" = 1 ]; then
  if [ -n "$ns" ]; then
    timeout 0.7 agent-browser --namespace "$ns" --session "$sess" --json close >/dev/null 2>&1 || true
  else
    timeout 0.7 agent-browser --session "$sess" --json close >/dev/null 2>&1 || true
  fi
fi
# Settle: terminate any live same-session daemon, including one started while a close attempt was
# timing out. Identity is re-verified on every round; bounded so a stuck shutdown cannot hang us.
round=0
while [ "$round" -lt 3 ]; do
  probe=$(cat "$pidfile" 2>/dev/null || true)
  case "$probe" in ""|*[!0-9]*) break;; esac
  [ -d "/proc/$probe" ] || break
  if ! out=$(node -e "$PIAB_KILL_JS" "$pidfile" "$sess" 2>&1); then echo "kill-script: $out"; fi
  sleep 0.2
  round=$((round+1))
done
probe=$(cat "$pidfile" 2>/dev/null || true)
remaining=0
case "$probe" in ""|*[!0-9]*) ;; *) [ -d "/proc/$probe" ] && remaining=1;; esac
if [ "$remaining" = 1 ]; then
  echo cleanup-unconfirmed; exit 1
fi
rm -rf -- "$staging" "$@"
echo cleanup-complete
`;
export function sanitizeNamespace(value: string): string {
  let out = ''; let separator = false;
  for (const char of value) {
    if (/[\p{Alphabetic}\p{Number}]/u.test(char)) { out += char.toLowerCase(); separator = false; }
    else if (out && !separator) { out += char === '_' ? '_' : '-'; separator = true; }
  }
  return out.replace(/[-_]+$/, '');
}
