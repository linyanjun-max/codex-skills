#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""OPC UA worker for the Simple-Scada 2 bridge.

Simple-Scada 2 can expose the variables of a running project through its
built-in OPC UA server (project settings -> built-in UA server, endpoint
opc.tcp://<host>:<port>). This worker is the transport used by the
`scada_values` tool: it speaks OPC UA with asyncua and emits one JSON object on
stdout, so the Node plugin never has to implement the binary OPC UA protocol.

Usage examples (argv form, JSON printed to stdout):

  python ua_worker.py status
  python ua_worker.py browse --endpoint opc.tcp://127.0.0.1:49875 --depth 2
  python ua_worker.py read   --endpoint ... --nodes "Objects/Project/Tank/Level,waterLevel"
  python ua_worker.py write  --endpoint ... --set '{"waterLevel": 90}'
  python ua_worker.py watch  --endpoint ... --nodes all --seconds 5 --interval 250

Node addressing: a node may be given as
  * a variable name from the project (matched against the browse name, case-insensitive),
  * a browse path separated by '/' from the Objects folder,
  * an "ns=2;s=..." NodeId string (passed through).
"""

import argparse
import json
import sys
import time
import traceback

try:
    from asyncua import Client, ua
except Exception:  # pragma: no cover - reported as JSON
    print(json.dumps({
        "ok": False,
        "error": "asyncua is not installed in this interpreter: " + traceback.format_exc(limit=1),
    }))
    sys.exit(2)


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False, default=str))
    sys.stdout.write("\n")
    sys.stdout.flush()


def value_to_json(value):
    """Convert an OPC UA value into something JSON-safe and lossless enough."""
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, bytes):
        return {"__bytes__": value.hex()}
    if isinstance(value, (list, tuple)):
        return [value_to_json(v) for v in value]
    if isinstance(value, dict):
        return {str(k): value_to_json(v) for k, v in value.items()}
    return {"__repr__": repr(value), "__type__": type(value).__name__}


def status_from(status):
    if status is None:
        return None
    try:
        name = status.name
    except Exception:
        name = str(status)
    return name


def connect(endpoint, user=None, password=None, timeout=10):
    client = Client(endpoint, timeout=timeout)
    if user:
        client.set_user(user)
    if password:
        client.set_password(password)
    return client


async def resolve_node(client, spec, cache):
    """Resolve a user-supplied node reference to an asyncua node object."""
    spec = str(spec).strip()
    objects = client.nodes.objects
    if spec.lower() in ("all", "*"):
        return objects
    if spec.startswith("ns=") and ";" in spec:
        try:
            return client.get_node(spec)
        except Exception:
            return None
    if spec.startswith("i="):
        try:
            return client.get_node(spec)
        except Exception:
            return None
    if "/" in spec:
        node = objects
        for part in [p for p in spec.split("/") if p]:
            children = await node.get_children()
            found = None
            for child in children:
                try:
                    bn = await child.read_browse_name()
                except Exception:
                    continue
                if bn.Name.lower() == part.lower():
                    found = child
                    break
            if found is None:
                return None
            node = found
        return node
    key = spec.lower()
    return cache.get(key)


async def build_index(client):
    """Map every Variable node under Objects by browse name and by full path."""
    index = {}
    objects = client.nodes.objects
    stack = [(objects, "")]
    while stack:
        node, prefix = stack.pop()
        try:
            children = await node.get_children()
        except Exception:
            continue
        for child in children:
            try:
                bn = await child.read_browse_name()
                nc = await child.read_node_class()
            except Exception:
                continue
            path = (prefix + "/" + bn.Name) if prefix else bn.Name
            if nc == ua.NodeClass.Variable:
                index.setdefault(bn.Name.lower(), child)
                index.setdefault(path.lower(), child)
            elif nc in (ua.NodeClass.Object, ):
                stack.append((child, path))
    return index


async def describe(node):
    out = {}
    try:
        bn = await node.read_browse_name()
        out["browseName"] = bn.Name
        out["nodeId"] = node.nodeid.to_string()
    except Exception:
        pass
    try:
        out["dataType"] = (await node.read_data_type_as_variant_type()).name
    except Exception:
        pass
    return out


async def read_many(client, specs):
    index = await build_index(client)
    results = []
    for spec in specs:
        node = await resolve_node(client, spec, index)
        if node is None:
            results.append({"node": spec, "error": "not found"})
            continue
        item = {"node": spec}
        item.update(await describe(node))
        try:
            dv = await node.read_data_value()
            item["value"] = value_to_json(dv.Value.Value)
            item["status"] = status_from(dv.StatusCode)
            item["sourceTimestamp"] = str(dv.SourceTimestamp)
            item["serverTimestamp"] = str(dv.ServerTimestamp)
        except Exception as exc:
            item["error"] = str(exc)
        results.append(item)
    return results


async def write_many(client, mapping):
    index = await build_index(client)
    results = []
    for name, value in mapping.items():
        node = await resolve_node(client, name, index)
        if node is None:
            results.append({"node": name, "ok": False, "error": "not found"})
            continue
        try:
            vt = await node.read_data_type_as_variant_type()
            coerced = coerce(value, vt)
            await node.write_value(ua.DataValue(ua.Variant(coerced, vt)))
            dv = await node.read_data_value()
            results.append({
                "node": name,
                "ok": True,
                "written": value_to_json(coerced),
                "readback": value_to_json(dv.Value.Value),
                "status": status_from(dv.StatusCode),
            })
        except Exception as exc:
            results.append({"node": name, "ok": False, "error": str(exc)})
    return results


def coerce(value, variant_type):
    name = getattr(variant_type, "name", str(variant_type))
    if name in ("Boolean",):
        if isinstance(value, str):
            return value.strip().lower() in ("1", "true", "yes", "on")
        return bool(value)
    if name in ("SByte", "Byte", "Int16", "UInt16", "Int32", "UInt32", "Int64", "UInt64"):
        return int(value)
    if name in ("Float", "Double"):
        return float(value)
    if name in ("String",):
        return "" if value is None else str(value)
    return value


async def cmd_browse(args):
    client = connect(args.endpoint, args.user, args.password, args.timeout)
    async with client:
        index = await build_index(client)
        entries = []
        for key, node in index.items():
            if "/" in key:
                continue
            info = await describe(node)
            info["key"] = key
            entries.append(info)
        entries.sort(key=lambda e: e.get("browseName", ""))
        emit({"ok": True, "endpoint": args.endpoint, "count": len(entries), "variables": entries[: args.limit]})


async def cmd_read(args):
    specs = [s.strip() for s in args.nodes.split(",") if s.strip()]
    client = connect(args.endpoint, args.user, args.password, args.timeout)
    async with client:
        values = await read_many(client, specs if specs else ["all"])
        if specs == [] or specs == ["all"]:
            index = await build_index(client)
            names = [n for n in index.keys() if "/" not in n]
            values = await read_many(client, names[: args.limit])
        emit({"ok": True, "endpoint": args.endpoint, "values": values})


async def cmd_write(args):
    mapping = json.loads(args.set)
    if not isinstance(mapping, dict):
        raise ValueError("--set must be a JSON object of {node: value}")
    client = connect(args.endpoint, args.user, args.password, args.timeout)
    async with client:
        results = await write_many(client, mapping)
        emit({"ok": True, "endpoint": args.endpoint, "writes": results})


async def cmd_watch(args):
    specs = [s.strip() for s in args.nodes.split(",") if s.strip()]
    client = connect(args.endpoint, args.user, args.password, args.timeout)
    async with client:
        index = await build_index(client)
        if not specs or specs == ["all"]:
            specs = [n for n in index.keys() if "/" not in n][: args.limit]
        deadline = time.time() + args.seconds
        samples = []
        while time.time() < deadline:
            values = await read_many(client, specs)
            samples.append({"t": time.strftime("%Y-%m-%dT%H:%M:%S"), "values": values})
            await asyncio_sleep(args.interval / 1000.0)
        emit({"ok": True, "endpoint": args.endpoint, "intervalMs": args.interval, "samples": samples})


async def asyncio_sleep(seconds):
    import asyncio
    await asyncio.sleep(seconds)


async def cmd_probe(args):
    """Report whether an endpoint speaks OPC UA (used for port discovery)."""
    try:
        client = connect(args.endpoint, args.user, args.password, args.timeout)
        async with client:
            info = {}
            try:
                endpoints = await client.get_endpoints()
                info["endpoints"] = [
                    {"url": e.EndpointUrl, "security": [p.PolicyUri for p in (e.SecurityPolicyUris or [])]} for e in endpoints[:5]
                ]
            except Exception as exc:
                info["endpointsError"] = str(exc)
            try:
                index = await build_index(client)
                info["variableCount"] = len([k for k in index.keys() if "/" not in k])
            except Exception as exc:
                info["indexError"] = str(exc)
            info["ok"] = True
            info["endpoint"] = args.endpoint
            emit(info)
    except Exception:
        emit({"ok": False, "endpoint": args.endpoint, "error": traceback.format_exc(limit=2)})


async def cmd_wait(args):
    deadline = time.time() + args.seconds
    last = None
    while time.time() < deadline:
        try:
            client = connect(args.endpoint, args.user, args.password, 4)
            async with client:
                emit({"ok": True, "endpoint": args.endpoint, "ready": True})
                return
        except Exception as exc:
            last = str(exc)
            await asyncio_sleep(1.0)
    emit({"ok": False, "endpoint": args.endpoint, "ready": False, "error": last or "timeout"})


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    st = sub.add_parser("status")
    st.set_defaults(func=lambda a: emit({"ok": True, "asyncua": getattr(__import__("asyncua"), "__version__", "?"), "python": sys.version.split()[0]}))

    for name in ("browse", "read", "write", "watch", "wait", "probe"):
        p = sub.add_parser(name)
        p.add_argument("--endpoint", required=True)
        p.add_argument("--user")
        p.add_argument("--password")
        p.add_argument("--timeout", type=float, default=10.0)
        p.add_argument("--limit", type=int, default=500)
        if name in ("read", "watch"):
            p.add_argument("--nodes", default="all")
        if name == "write":
            p.add_argument("--set", required=True)
        if name == "watch":
            p.add_argument("--seconds", type=float, default=5.0)
            p.add_argument("--interval", type=int, default=250)
        if name == "wait":
            p.add_argument("--seconds", type=float, default=30.0)

    args = ap.parse_args()
    handlers = {"browse": cmd_browse, "read": cmd_read, "write": cmd_write, "watch": cmd_watch, "wait": cmd_wait, "probe": cmd_probe}
    if args.cmd == "status":
        args.func(args)
        return 0
    try:
        import asyncio
        asyncio.run(handlers[args.cmd](args))
        return 0
    except Exception:
        emit({"ok": False, "error": traceback.format_exc()})
        return 1


if __name__ == "__main__":
    sys.exit(main())
