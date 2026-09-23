"""Create/verify public derivatives of the frozen offline benchmark containers.

Usage: python3 scripts/sanitize-benchmark-publication.py PRIVATE_DIR PUBLIC_DIR [--verify]
Original measurements are never overwritten. Only path metadata and archive
headers change; this program does not execute the benchmark.
"""
import argparse
import copy
import gzip
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import tarfile

if not __debug__:
    raise SystemExit("Refusing optimized Python: publication integrity assertions must remain enabled")

ORIGINALS = {
    "summary.json": "bbaf4645539407439438dab02cffce7c48a6512cbea5b78c6deae933c2757130",
    "development-evidence.frozen.tar.gz": "563bf583544ae3592195b495fe93b2ee959b37cb2b8b6a6e40cfd83859278890",
    "measurement-sources.frozen.tar.gz": "bf06c0d6427123264b6d28f5b5914843bc01f2880ef7ed152b82dd9c59394942",
}
DEV_SUMMARY = "jevfuzz-v4-development-merged/summary.json"
def sha(data):
    return hashlib.sha256(data).hexdigest()

def summary(data, development=False):
    original = json.loads(data)
    result = copy.deepcopy(original)
    root = "jevfuzz-v4-development-merged" if development else "fixtures/benchmarks/raw-v09-v4"
    manifest = "manifest-development.json" if development else "manifest-v4.json"
    result["command"] = f"node scripts/benchmark-v09.ts --merge-shards <retained-shard-directories> --out {root} --manifest fixtures/benchmarks/{manifest}"
    result["raw"]["directory"] = root
    result["publicationSanitization"] = {
        "version": 1, "originalSha256": sha(data),
        "changedFields": ["command", "raw.directory"], "measurementRerun": False,
        "note": "Portable command template replaces workstation paths. Statistical fields and frozen identities are unchanged.",
    }
    restored = copy.deepcopy(result)
    del restored["publicationSanitization"]
    restored["command"] = original["command"]
    restored["raw"]["directory"] = original["raw"]["directory"]
    assert restored == original
    return (json.dumps(result, indent=2) + "\n").encode()

def members(data):
    result = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        for member in archive:
            path = PurePosixPath(member.name)
            assert member.isfile() and not path.is_absolute() and ".." not in path.parts
            assert member.name not in result and str(path) == member.name
            result[member.name] = archive.extractfile(member).read()
    return result

def archive(contents):
    tar = io.BytesIO()
    with tarfile.open(fileobj=tar, mode="w", format=tarfile.USTAR_FORMAT) as output:
        for name, data in sorted(contents.items()):
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = 0o644
            output.addfile(info, io.BytesIO(data))
    out = io.BytesIO()
    with gzip.GzipFile(fileobj=out, mode="wb", filename="", mtime=0, compresslevel=9) as output:
        output.write(tar.getvalue())
    return out.getvalue()

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("private", type=Path)
    parser.add_argument("public", type=Path)
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    assert args.private.resolve() != args.public.resolve(), "Originals must be separate"
    originals = {name: (args.private / name).read_bytes() for name in ORIGINALS}
    for name, digest in ORIGINALS.items():
        assert sha(originals[name]) == digest, f"Unexpected original: {name}"
    measurement = members(originals["measurement-sources.frozen.tar.gz"])
    frozen = json.loads((args.public / "sources.frozen.json").read_bytes())
    assert frozen == json.loads(originals["summary.json"])["sourceHashes"], "Frozen source descriptor changed"
    assert sha((args.public / "manifest.frozen.json").read_bytes()) == frozen["manifestHash"], "Frozen manifest changed"
    assert set(measurement) == set(frozen["sources"]) | {"package.json"}
    for name, digest in frozen["sources"].items():
        assert sha(measurement[name]) == digest, name
    dev = members(originals["development-evidence.frozen.tar.gz"])
    assert sha(dev[DEV_SUMMARY]) == "0d9392d7a81dde9f49e5da5e7c945552c2672c76ce5f5a20e2ec091da2c738d0"
    dev[DEV_SUMMARY] = summary(dev[DEV_SUMMARY], development=True)
    outputs = {
        "summary.json": summary(originals["summary.json"]),
        "development-evidence.frozen.tar.gz": archive(dev),
        "measurement-sources.frozen.tar.gz": archive(measurement),
    }
    for name, data in outputs.items():
        path = args.public / name
        if args.verify:
            assert path.read_bytes() == data, f"Public derivative differs: {name}"
        else:
            temporary = path.with_suffix(path.suffix + ".tmp")
            temporary.write_bytes(data)
            temporary.replace(path)
    trials = (args.public / "trials.jsonl").read_bytes()
    assert sha(trials) == "cfbb6753fd23ba2a73412dacb368ff67847beb52f2d759706edb4dc5bc140be1"
    rows = [json.loads(row) for row in trials.splitlines()]
    assert len(rows) == 6000 and all(row["sourceHash"] == frozen["sourceHash"] for row in rows)
    print(json.dumps({"verified": args.verify, "trials": len(rows), "archivedSourceFiles": len(frozen["sources"]), "sha256": {name: sha(data) for name, data in outputs.items()}}, indent=2))

if __name__ == "__main__":
    main()
