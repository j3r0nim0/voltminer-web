#!/usr/bin/env python3
"""Login to gulf.moneroocean.stream:20032 and dump one rx/0 job."""
import json
import ssl
import socket
import sys

WALLET = (
    "86sz6KHAVBcapMG5HXzgapHFB4Jd2uqcC5kH7Jp6hCMYY7uBUPg28k9DiuuVQjFfGA8B3JcqGrsc4ZgYnTE56gtJPMDVJwt"
    "+10000"
)
HOST = "gulf.moneroocean.stream"
PORT = 20032


def recv_json_lines(sock, timeout=12):
    sock.settimeout(timeout)
    buf = b""
    jobs = []
    login = None
    while True:
        try:
            chunk = sock.recv(4096)
        except socket.timeout:
            break
        if not chunk:
            break
        buf += chunk
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line.decode())
            if obj.get("method") == "job" and obj.get("params"):
                jobs.append(obj["params"])
            elif "result" in obj and obj.get("result") and isinstance(obj["result"], dict):
                login = obj["result"]
                if obj["result"].get("job"):
                    jobs.append(obj["result"]["job"])
            if jobs:
                return login, jobs[0]
    return login, jobs[0] if jobs else None


def main():
    ctx = ssl._create_unverified_context()
    raw = socket.create_connection((HOST, PORT), timeout=15)
    sock = ctx.wrap_socket(raw, server_hostname=HOST)
    login = {
        "id": 1,
        "jsonrpc": "2.0",
        "method": "login",
        "params": {
            "login": WALLET,
            "pass": "VMW-localtest",
            "rigid": "VMW-localtest",
            "agent": "VoltMiner-web/rx-local-test",
            "algo": ["rx/0", "rx/wow"],
        },
    }
    sock.sendall((json.dumps(login) + "\n").encode())
    _login_res, job = recv_json_lines(sock)
    sock.close()
    if not job:
        print("NO_JOB", file=sys.stderr)
        sys.exit(1)
    out = {
        "job_id": job.get("job_id"),
        "blob": job.get("blob"),
        "target": job.get("target"),
        "seed_hash": job.get("seed_hash") or job.get("seedhash"),
        "height": job.get("height"),
        "algo": job.get("algo") or job.get("algorithm") or "rx/0",
    }
    path = "/tmp/rx-local-test/job.json"
    with open(path, "w") as f:
        json.dump(out, f, indent=2)
        f.write("\n")
    print(json.dumps(out, indent=2))
    print("wrote", path, file=sys.stderr)


if __name__ == "__main__":
    main()
