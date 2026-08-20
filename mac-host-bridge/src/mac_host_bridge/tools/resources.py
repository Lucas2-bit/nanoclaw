import psutil


def get_system_resources() -> dict:
    cpu_percent = psutil.cpu_percent(interval=0.5)
    mem = psutil.virtual_memory()
    disk = psutil.disk_usage("/")

    return {
        "cpu": {
            "percent_used": cpu_percent,
            "core_count_logical": psutil.cpu_count(logical=True),
            "core_count_physical": psutil.cpu_count(logical=False),
        },
        "memory": {
            "total_gb": round(mem.total / 1e9, 2),
            "available_gb": round(mem.available / 1e9, 2),
            "used_gb": round(mem.used / 1e9, 2),
            "percent_used": mem.percent,
        },
        "disk": {
            "mount": "/",
            "total_gb": round(disk.total / 1e9, 2),
            "free_gb": round(disk.free / 1e9, 2),
            "used_gb": round(disk.used / 1e9, 2),
            "percent_used": disk.percent,
        },
    }
