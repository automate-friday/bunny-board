import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {readFileSync} from "node:fs";
import path from "node:path";
import os from "node:os";
const exec=promisify(execFile);
// The OS owns this advisory lock: it is released when the Python worker exits,
// including crashes. Its child processes stay covered while the server restarts.
// Manual Parakeet runs do not use this lock, so also refuse while one is running.
const TRANSCRIBE = String.raw`
import os,sys,fcntl,subprocess
source,out,lock=sys.argv[1:]
with open(lock,'a+') as handle:
    try: fcntl.flock(handle,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError: raise RuntimeError('Another intake transcription is running; retry later')
    lines=subprocess.check_output(['ps','-axo','pid=,comm=,args='],text=True).splitlines()
    for line in lines:
        # Match actual Python/Parakeet executables, not shell prompts containing a recipe.
        parts=line.strip().split(None,2)
        if len(parts)!=3 or parts[0]==str(os.getpid()): continue
        parts=parts[1:]
        if len(parts)==2 and ('python' in os.path.basename(parts[0]).lower() or 'parakeet' in os.path.basename(parts[0]).lower()):
            if '/parakeet-mlx ' in parts[1] or ' -m parakeet_mlx ' in parts[1]:
                raise RuntimeError('Another Parakeet transcription is running; retry when it finishes')
    os.set_inheritable(handle.fileno(),True)
    audio=os.path.join(out,'audio.wav')
    subprocess.run(['nice','-n','10','ffmpeg','-v','error','-nostdin','-y','-i',source,'-vn','-ac','1','-ar','16000',audio],check=True,pass_fds=(handle.fileno(),))
    subprocess.run(['nice','-n','10','parakeet-mlx',audio,'--output-dir',out,'--output-format','all','--output-template','parakeet'],check=True,env={**os.environ,'HF_HUB_OFFLINE':'1'},pass_fds=(handle.fileno(),))
    text=open(os.path.join(out,'parakeet.txt')).read()
    if not text.strip(): raise RuntimeError('transcription returned no text')
    with open(os.path.join(out,'transcript.txt.tmp'),'w') as f: f.write(text); f.flush(); os.fsync(f.fileno())
    os.replace(os.path.join(out,'transcript.txt.tmp'),os.path.join(out,'transcript.txt'))
`;
export async function offlineTranscribe(file: string, out: string): Promise<string> {
  await exec('python3', ['-c', TRANSCRIBE, file, out, path.join(os.tmpdir(), 'af-parakeet-transcription.flock')], { env: { ...process.env, HF_HUB_OFFLINE: '1' }, maxBuffer: 8_000_000 });
  return readFileSync(path.join(out, 'parakeet.txt'), 'utf8');
}
