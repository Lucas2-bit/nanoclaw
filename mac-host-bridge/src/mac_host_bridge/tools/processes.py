import psutil


def list_processes(name_filter: str = "", limit: int = 50) -> dict:
    if limit < 1:
        limit = 1
    if limit > 200:
        limit = 200

    results = []
    attrs = ["pid", "name", "cpu_percent", "memory_info", "status", "username"]

    for proc in psutil.process_iter(attrs):
        try:
            info = proc.info
            name = info.get("name") or ""
            if name_filter and name_filter.lower() not in name.lower():
                continue
            mem = info.get("memory_info")
            results.append({
                "pid": info["pid"],
                "name": name,
                "cpu_percent": info.get("cpu_percent") or 0.0,
                "memory_mb": round(mem.rss / 1024 / 1024, 1) if mem else 0.0,
                "status": info.get("status"),
                "user": info.get("username"),
            })
            if len(results) >= limit:
                break
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            continue

    return {
        "count": len(results),
        "filter": name_filter or None,
        "limit_applied": limit,
        "processes": results,
    }
