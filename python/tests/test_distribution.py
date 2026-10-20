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
import tarfile
from datetime import datetime, timedelta, timezone

PACKAGE = Path(__file__).resolve().parents[1]
CLI = Path(os.environ.get("WORKTRUST_TEST_CLI_SOURCE", PACKAGE.parent / "worktrust-cli")).resolve()
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
    if os.name == "nt":
        env.update({key:os.environ[key] for key in ("SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP") if key in os.environ})
    buildenv = dict(env, PATH=os.environ.get("PATH", ""))
    signed_wheel = os.environ.get("WORKTRUST_SIGNED_WHEEL")
    if signed_wheel:
        (scratch/"dist").mkdir()
        for path in (signed_wheel, os.environ["WORKTRUST_SIGNED_SOURCE"]):
            shutil.copyfile(path, scratch/"dist"/Path(path).name)
    else:
        for kind in ("--wheel", "--sdist"):
            build = subprocess.run([sys.executable,"-m","build",kind,"--no-isolation","--outdir",str(scratch/"dist"),str(PACKAGE)],env=buildenv,capture_output=True,text=True)
            check(build.returncode == 0, build.stdout + build.stderr)
    wheel = next((scratch/"dist").glob("*.whl"))
    installed = scratch / "installed"
    with zipfile.ZipFile(wheel) as archive:
        archive.extractall(installed)
        for member in archive.infolist():
            if member.filename.endswith("/runtime/node"):
                (installed/member.filename).chmod(0o755)
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
    if not signed_wheel:
        # Source CI checks exact unsigned build bytes above, then uses a distinct, explicitly
        # synthetic bootstrap for executable smoke. Only the original unsigned artifacts are retained.
        from sign_fixture import fixture_wheel
        fixture = scratch/"fixture-wheel"/wheel.name
        fixture_wheel(wheel, fixture)
        wheel = fixture
        shutil.rmtree(installed)
        with zipfile.ZipFile(wheel) as archive:
            archive.extractall(installed)
            for member in archive.infolist():
                if member.filename.endswith("/runtime/node"):
                    (installed/member.filename).chmod(0o755)

    def run(args=(), changes=None):
        return subprocess.run([sys.executable,"-m","worktrust_cli",*args],env=dict(env,**(changes or {})),cwd=scratch,capture_output=True,text=True,timeout=45)

    runtime_dir = installed/"worktrust_cli/runtime"
    runtime_metadata = json.loads((runtime_dir/"runtime.json").read_text())
    NODE = str(runtime_dir/runtime_metadata["executable"])
    lock = json.loads((PACKAGE/"runtime-lock.json").read_text())
    check(runtime_metadata["version"] == lock["version"], "pinned Node release")
    check(wheel.name.endswith(lock["targets"][runtime_metadata["platform"]]["wheel_tag"]+".whl"), "correct native wheel tag")
    check("none-any" not in wheel.name, "native runtime never mislabeled universal")
    check(not shutil.which("node",path=env["PATH"]), "no Node installed on test PATH")
    check("Node.js" in (runtime_dir/"LICENSE").read_text(), "full Node license shipped")
    node_version = subprocess.run([NODE,"--version"],env=env,capture_output=True,text=True)
    check(node_version.returncode == 0 and node_version.stdout.strip() == "v"+lock["version"], "actual bundled runtime version matches pin")
    signed_npm = os.environ.get("WORKTRUST_SIGNED_NPM")
    if signed_npm:
        npm_root = scratch/"signed-npm"; npm_root.mkdir()
        with tarfile.open(signed_npm, "r:gz") as archive:
            total = 0
            for member in archive:
                check(member.isfile() and member.size <= 128*1024*1024, "signed npm archive contains regular bounded files")
                total += member.size; check(total <= 256*1024*1024, "signed npm archive total bound")
                destination = npm_root/member.name
                check(destination.resolve().is_relative_to(npm_root.resolve()), "signed npm member stays in its directory")
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(archive.extractfile(member).read())
        npm_entry = npm_root/"package/worktrust-launch.mjs"
        result = subprocess.run([NODE, str(npm_entry), "--version"], env=env, cwd=scratch, capture_output=True, text=True, timeout=20)
        check(result.returncode == 0 and result.stdout.strip() == npm["version"], "final signed npm launcher works on this native platform")
        (npm_root/"package/log-session.mjs").write_bytes(b"SYNTHETIC_TAMPERED_ENGINE")
        result = subprocess.run([NODE, str(npm_entry), "--version"], env=env, cwd=scratch, capture_output=True, text=True, timeout=20)
        check(result.returncode == 1 and "PACKAGE_FILE_CHANGED" in result.stderr, "final npm launcher refuses modified engine before execution")
    telemetry = subprocess.run([sys.executable, str(PACKAGE/"tests/test_telemetry.py"), "--installed"],
                               env=dict(env, WORKTRUST_TEST_NODE=NODE, WORKTRUST_TEST_CLI_SOURCE=str(bundle)),
                               cwd=scratch, capture_output=True, text=True, timeout=60)
    check(telemetry.returncode == 0, "installed SDK/shared engine parity: " + telemetry.stdout + telemetry.stderr)
    sqlite = subprocess.run([NODE,"--input-type=module","-e","import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(':memory:'); console.log(db.prepare('select 42 as n').get().n); db.close();"],env=env,capture_output=True,text=True)
    check(sqlite.returncode == 0 and sqlite.stdout.strip() == "42", "bundled runtime supports SQLite readers")
    with tarfile.open(next((scratch/"dist").glob("*.tar.gz"))) as source_archive:
        members = source_archive.getmembers()
        check(not any("/runtime/" in member.name for member in members), "sdist contains no platform binary")
        source_directory = scratch/"source-build"
        for member in members:
            if member.isfile():
                target = source_directory/member.name
                check(target.resolve().is_relative_to(source_directory.resolve()), "sdist path remains inside extraction")
                target.parent.mkdir(parents=True,exist_ok=True)
                target.write_bytes(source_archive.extractfile(member).read())
    source_root = next(source_directory.iterdir())
    source_build = subprocess.run([sys.executable,"-m","build","--wheel","--no-isolation",str(source_root)],env=buildenv,capture_output=True,text=True)
    check(source_build.returncode != 0 and "Bundled runtime is absent" in source_build.stdout+source_build.stderr, "unstaged sdist wheel fails closed without runtime download")
    # A synthetic transport fixture selects an entry explicitly; NODE_OPTIONS is never a permitted bypass.
    intercept = scratch/"intercept.mjs"
    intercept.write_text("console.log(JSON.stringify({args:process.argv.slice(2),agent:process.env.CLAUDECODE,relay:process.env.WORKTRUST_RELAYED}));console.error('synthetic stderr');process.exit(7);\n")
    args = ["literal space", "$(never-run)", "; touch SHOULD_NOT_EXIST", "quote'\""]
    blocked = run(["--version"], {"NODE_OPTIONS":f"--import={intercept.as_uri()}", "NODE_PATH":str(scratch)})
    check(blocked.returncode == 0 and blocked.stdout.strip() == npm["version"] and "synthetic stderr" not in blocked.stderr,
          "official Python launcher removes Node preload injection before execution")
    transport = "import pathlib,sys,worktrust_cli as cli; cli.verified_entry=lambda:pathlib.Path(" + repr(str(intercept)) + "); sys.exit(cli.main())"
    result = subprocess.run([sys.executable,"-c",transport,*args], env=dict(env,CLAUDECODE="1"),
                            cwd=scratch,capture_output=True,text=True,timeout=20)
    check(result.returncode == 7,"child exit propagated")
    check(json.loads(result.stdout) == {"args":args,"agent":"1","relay":"1"},"literal args and agent environment preserved")
    check(result.stderr.strip() == "synthetic stderr" and not (scratch/"SHOULD_NOT_EXIST").exists(),"stdio preserved without shell")
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
    check("PACKAGE_FILE_CHANGED" in run(["--help"]).stderr,"modified bundle refused before runtime execution")
    (bundle/"stack-rules.mjs").unlink()
    check("PACKAGE_FILE_LIST_CHANGED" in run(["--help"]).stderr,"missing bundle refused")
    (bundle/"stack-rules.mjs").write_bytes(original)
    (bundle/"unexpected.mjs").write_text("")
    check("PACKAGE_FILE_LIST_CHANGED" in run(["--help"]).stderr,"extra bundle refused")
    (bundle/"unexpected.mjs").unlink()
    binary = Path(NODE)
    original_binary = binary.read_bytes()
    binary.write_bytes(original_binary+b"tampered")
    check("PACKAGE_FILE_CHANGED" in run(["--help"]).stderr,"tampered native runtime refused before execution")
    binary.unlink()
    check("PACKAGE_FILE_LIST_CHANGED" in run(["--help"]).stderr,"missing native runtime refused without PATH fallback")
    binary.write_bytes(original_binary)
    binary.chmod(0o755)

    # Tool-runner smoke uses the built artifact, never a public WorkTrust namespace.
    if os.name != "nt":
        for name in ("realpath", "dirname"):
            helper = shutil.which(name)
            if helper:
                (binaries/name).symlink_to(helper)
    for tool, args in (("uv",["tool","run","--offline","--from",str(wheel),"worktrust","--help"]),("pipx",["run","--spec",str(wheel),"worktrust","--help"])):
        command = tool + (".exe" if os.name == "nt" else "")
        executable = next((candidate for candidate in (Path(sys.executable).parent/command, Path(sys.executable).parent/"Scripts"/command) if candidate.exists()), Path(sys.executable).parent/command)
        if executable.exists():
            toolenv = dict(env, PATH=os.pathsep.join([str(binaries)] + ([str(Path(os.environ["SYSTEMROOT"])/"System32")] if os.name == "nt" else [])), UV_PYTHON=sys.executable, UV_PYTHON_DOWNLOADS="never", UV_CACHE_DIR=str(scratch/"uv-cache"), PIPX_HOME=str(scratch/"pipx"), PIPX_BIN_DIR=str(scratch/"pipx-bin"), PIPX_DEFAULT_PYTHON=sys.executable, PIP_NO_INDEX="1")
            wheelhouse = os.environ.get("WORKTRUST_TEST_WHEELHOUSE")
            if wheelhouse:
                toolenv.update(PIP_FIND_LINKS=wheelhouse, UV_FIND_LINKS=wheelhouse)
            check(shutil.which("node",path=toolenv["PATH"]) is None, f"{tool} runs without Node on PATH")
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
