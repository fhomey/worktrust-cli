"""Exercise shipped bytes, not an editable install. Never use the owner's home."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import zipfile
from datetime import datetime, timedelta, timezone

PACKAGE = Path(__file__).resolve().parents[1]
CLI = Path(os.environ.get("WORKTRUST_TEST_CLI_SOURCE", PACKAGE.parent / "worktrust-cli")).resolve()
NODE = os.environ["WORKTRUST_TEST_NODE"]
count = 0


def check(value, message):
    global count
    assert value, message
    count += 1


with tempfile.TemporaryDirectory(prefix="worktrust-python-test-") as temporary:
    scratch = Path(temporary)
    home = scratch / "home"
    home.mkdir()
    binaries = scratch / "bin"
    binaries.mkdir()
    # A new, explicitly synthetic environment, not a filtered owner session.
    env = {"HOME":str(home), "USERPROFILE":str(home), "PATH":str(binaries),
           "WORKTRUST_RELAYED":"1", "PYTHONUTF8":"1"}
    buildenv = dict(env, PATH=os.environ.get("PATH", ""))
    build = subprocess.run([sys.executable,"-m","build","--no-isolation","--outdir",str(scratch/"dist"),str(PACKAGE)],env=buildenv,capture_output=True,text=True)
    check(build.returncode == 0, build.stdout + build.stderr)
    wheel = next((scratch/"dist").glob("*.whl"))
    installed = scratch / "installed"
    with zipfile.ZipFile(wheel) as archive:
        archive.extractall(installed)
        entrypoints = archive.read(next(n for n in archive.namelist() if n.endswith("entry_points.txt"))).decode()
        metadata = archive.read(next(n for n in archive.namelist() if n.endswith(".dist-info/METADATA"))).decode()
        check("worktrust = worktrust_cli:main" in entrypoints, "wheel console entrypoint")
    env["PYTHONPATH"] = str(installed)
    bundle = installed / "worktrust_cli/bundle"
    manifest = json.loads((bundle/"manifest.json").read_text())
    npm = json.loads((CLI/"package.json").read_text())
    check(f"Version: {npm['version']}" in metadata.splitlines(), "wheel metadata matches the CLI release version")
    check(manifest["version"] == npm["version"], "same release version")
    check(set(manifest["files"]) == {n for n in npm["files"] if n.endswith(".mjs")}, "same modules")
    for name, digest in manifest["files"].items():
        original = (CLI/name).read_bytes()
        check((bundle/name).read_bytes() == original and hashlib.sha256(original).hexdigest() == digest, name)

    def run(args=(), changes=None):
        return subprocess.run([sys.executable,"-m","worktrust_cli",*args],env=dict(env,**(changes or {})),cwd=scratch,capture_output=True,text=True,timeout=45)

    result = run(["--help"])
    check(result.returncode == 1 and "Node.js 22.5" in result.stderr,"missing Node is explicit")
    fake = binaries / "node"
    if os.name == "nt":
        raise RuntimeError("Windows fixture requires a real node.exe fixture; run native Windows matrix before release")
    fake.write_text(f"#!{sys.executable}\nimport sys\nprint('v20.0.0')\n")
    fake.chmod(0o755)
    result = run(["--help"])
    check(result.returncode == 1 and "22.5" in result.stderr,"old Node refused")
    fake.write_text(f"#!{sys.executable}\nimport sys,json,os\nif sys.argv[1:] == ['--version']:\n print('v22.5.0');sys.exit(0)\nprint(json.dumps({{'args':sys.argv[2:], 'agent':os.environ.get('CLAUDECODE'), 'relay':os.environ.get('WORKTRUST_RELAYED')}}))\nprint('synthetic stderr',file=sys.stderr)\nsys.exit(7)\n")
    args = ["literal space", "$(never-run)", "; touch SHOULD_NOT_EXIST", "quote'\""]
    result = run(args,{"CLAUDECODE":"1"})
    check(result.returncode == 7,"child exit propagated")
    check(json.loads(result.stdout) == {"args":args,"agent":"1","relay":"1"},"literal args and agent environment preserved")
    check(result.stderr.strip() == "synthetic stderr" and not (scratch/"SHOULD_NOT_EXIST").exists(),"stdio preserved without shell")
    fake.unlink()
    fake.symlink_to(NODE)
    result = run(["--help"])
    check(result.returncode == 0 and "WorkTrust" in result.stdout,"real engine help")
    check(not list(home.iterdir()),"help does not inspect/create coupling")
    result = run(["--version"])
    check(result.returncode == 0 and npm["version"] in result.stdout,"real engine version")
    for args in ([],["preserve","--yes"],["connect","--yes"]):
        result = run(args,{"CLAUDECODE":"1"})
        check(result.returncode != 0 and ("agent" in result.stdout.lower()+result.stderr.lower()),"agent guard remains")
    session_dir = home / ".claude/projects/synthetic-project"
    session_dir.mkdir(parents=True)
    begin = datetime.now(timezone.utc).replace(hour=10, minute=0, second=0, microsecond=0) - timedelta(days=3)
    rows = []
    for index in range(4):
        role = "user" if index % 2 == 0 else "assistant"
        message = {"role":role,"content":"SYNTHETIC_PRIVATE_TEXT"}
        if role == "assistant":
            message.update(model="synthetic-model",usage={"input_tokens":100,"output_tokens":50})
        rows.append(json.dumps({"type":role,"timestamp":(begin+timedelta(seconds=index*60)).isoformat(),"cwd":"/nonexistent/synthetic-project","message":message}))
    (session_dir/"session.jsonl").write_text("\n".join(rows)+"\n")
    valid_archive = scratch/"synthetic archive"
    archived = run(["preserve","--archive",str(valid_archive)])
    check(archived.returncode == 0 and (valid_archive/"manifest.json").exists(), archived.stdout+archived.stderr)
    for option in ("--summary","--verify"):
        args = ["preserve",option,str(valid_archive)]
        wrapper = run(args)
        canonical = subprocess.run([NODE,str(CLI/"worktrust.mjs"),*args],env=env,cwd=scratch,capture_output=True,text=True,timeout=45)
        check(wrapper.returncode == 0 and (wrapper.stdout,wrapper.stderr)==(canonical.stdout,canonical.stderr),"valid archive parity")
        check("SYNTHETIC_PRIVATE_TEXT" not in wrapper.stdout,"summary excludes source content")
        if option == "--summary":
            check("synthetic-model" in wrapper.stdout,"fixture produced measured summary")
    # Use identical synthetic input for the real preserve command through both launch paths.
    archive_path = scratch / "missing synthetic archive"
    for args in (["preserve","--summary",str(archive_path)],["preserve","--verify",str(archive_path)]):
        wrapper = run(args)
        canonical = subprocess.run([NODE,str(CLI/"worktrust.mjs"),*args],env=env,cwd=scratch,capture_output=True,text=True,timeout=45)
        check((wrapper.returncode,wrapper.stdout,wrapper.stderr)==(canonical.returncode,canonical.stdout,canonical.stderr),"preserve parity")
    # Actual summary arithmetic over fixed metadata also runs the exact shared module.
    fixture = [{"client":"claude-code","day":"2026-01-01","seconds":600,"model":"synthetic-model","tokens_in":100,"tokens_out":50,"started_at":"2026-01-01T10:00:00Z","ended_at":"2026-01-01T10:10:00Z"}]
    outputs = []
    for module in (bundle/"preserve-summary.mjs",CLI/"preserve-summary.mjs"):
        script = f"import {{summaryLines}} from {json.dumps(module.as_uri())}; console.log(JSON.stringify(summaryLines({json.dumps(fixture)})));"
        result = subprocess.run([NODE,"--input-type=module","-e",script],env=env,cwd=scratch,capture_output=True,text=True)
        check(result.returncode == 0,result.stderr)
        outputs.append(result.stdout)
    check(outputs[0] == outputs[1] and "synthetic-model" in outputs[0],"canonical summary arithmetic parity")
    original = (bundle/"stack-rules.mjs").read_bytes()
    (bundle/"stack-rules.mjs").write_bytes(original+b"\n// modified\n")
    check("integrity" in run(["--help"]).stderr,"modified bundle refused")
    (bundle/"stack-rules.mjs").unlink()
    check("file list" in run(["--help"]).stderr,"missing bundle refused")
    (bundle/"stack-rules.mjs").write_bytes(original)
    (bundle/"unexpected.mjs").write_text("")
    check("file list" in run(["--help"]).stderr,"extra bundle refused")
    # Tool-runner smoke uses the built artifact, never a public WorkTrust namespace.
    for tool, args in (("uv",["tool","run","--offline","--from",str(wheel),"worktrust","--help"]),("pipx",["run","--spec",str(wheel),"worktrust","--help"])):
        executable = Path(sys.executable).parent/tool
        if executable.exists():
            toolenv = dict(env, PATH=os.pathsep.join([str(binaries),str(Path(sys.executable).parent),"/usr/bin","/bin"]), UV_PYTHON=sys.executable, UV_PYTHON_DOWNLOADS="never", UV_CACHE_DIR=str(scratch/"uv-cache"), PIPX_HOME=str(scratch/"pipx"), PIPX_BIN_DIR=str(scratch/"pipx-bin"), PIPX_DEFAULT_PYTHON=sys.executable, PIP_NO_INDEX="1")
            toolenv.pop("PYTHONPATH",None)
            result = subprocess.run([str(executable),*args],env=toolenv,cwd=scratch,capture_output=True,text=True,timeout=120)
            check(result.returncode == 0 and "WorkTrust" in result.stdout, f"{tool}: {result.stdout} {result.stderr}")
        else:
            check(os.environ.get("WORKTRUST_REQUIRE_TOOL_RUNNERS") != "1", f"Required tool runner missing: {tool}")
            print(f"NOT RUN: optional {tool} artifact smoke (tool unavailable)")
    artifact_directory = os.environ.get("WORKTRUST_TEST_ARTIFACT_DIR")
    if artifact_directory:
        destination = Path(artifact_directory).expanduser().resolve()
        destination.mkdir(parents=True, exist_ok=True)
        for source in sorted((scratch/"dist").iterdir()):
            target = destination/source.name
            # Exclusive creation: never replace a previously reviewed artifact, even at this version.
            with target.open("xb") as handle:
                handle.write(source.read_bytes())
        print(f"Tested artifacts retained: {destination}")
print(f"Python CLI: {count} checks passed; actual wheel and sdist built")
