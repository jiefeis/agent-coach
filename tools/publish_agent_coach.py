"""Preflight accepted agent-coach releases from a sidecar manifest; offline by default.

Protocol: https://skillhub.cn/ai/release.md and official CLI 2026.8.5.
Never import the global CLI or rewrite the ZIP. Real submission belongs to the controller.
Known 1.17.0 was submitted through the browser; it must never be submitted again.
"""

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import uuid
import zipfile
from email import policy
from email.parser import BytesParser
import urllib.error
import urllib.parse
import urllib.request

API = "https://api.skillhub.cn"
OWNER = "user_0fdf85d4"
SLUG = "agent-coach"
NAME = "Agent 搭建教练"
CREDENTIALS = Path.home() / ".skillhub" / "credentials.json"
WORKSPACE = None  # Tests replace this in memory; production resolves the owning project.
RECEIPTS = Path("docs/evidence/SkillHubCLI接入-20261105/提交回执")
PUBLIC_URL = "https://skillhub.cn/skills/" + OWNER + "/" + SLUG
MEMBER_PATHS = frozenset((
    'SKILL.md',
    'AGENTS.md',
    'CLAUDE.md',
    'README.md',
    '做法/1-建项目.md',
    '模板/AGENTS.模板.md',
    '模板/CLAUDE.模板.md',
    '模板/README.模板.md',
    '模板/docs/PROJECT_INDEX.模板.md',
    '工具/coach-check.mjs',
    '做法/共用.md',
    '讲解/五站总览.html',
    '做法/0-体检.md',
    '做法/0-修复复诊.md',
    '做法/2-新做-说清需求.md',
    '做法/2-SOP-拆开SOP.md',
    '做法/3-排表画图.md',
    '做法/4-一步一票.md',
    '做法/5-收尾交接.md',
    '做法/架构推荐表.md',
    '模板/docs/INTAKE-新做.模板.md',
    '模板/docs/INTAKE-SOP.模板.md',
    '模板/docs/run-flow.模板.md',
    '模板/docs/票.模板.md',
))

class Stop(Exception):
    """Only constant, non-secret reason codes may be used here."""


class QuietParser(argparse.ArgumentParser):
    def error(self, message):
        raise Stop("arguments_invalid")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def digest(data):
    return hashlib.sha256(data).hexdigest()


def version_key(value):
    if not isinstance(value, str):
        raise Stop("version_invalid")
    found = re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?", value)
    if not found:
        raise Stop("version_invalid")
    prerelease = found[4]
    identifiers = []
    for part in prerelease.split(".") if prerelease else []:
        if part.isdigit() and len(part) > 1 and part.startswith("0"):
            raise Stop("version_invalid")
        identifiers.append((0, int(part)) if part.isdigit() else (1, part))
    return tuple(map(int, found.group(1, 2, 3))) + (0 if prerelease else 1, tuple(identifiers))


def local_version(value):
    if not isinstance(value, str):
        raise Stop("acceptance_invalid")
    value = value.removeprefix("v")
    if re.fullmatch(r"[0-9]+\.[0-9]+", value):
        value += ".0"
    version_key(value)
    return value


def workspace():
    if WORKSPACE is not None:
        return Path(WORKSPACE).resolve()
    for parent in Path(__file__).resolve().parents:
        if (parent / "AGENTS.md").is_file() and (parent / "docs/evidence/当前试用候选.json").is_file():
            return parent
    raise Stop("workspace_not_found")


def json_file(path, reason):
    try:
        raw = Path(path).read_bytes()
        value = json.loads(raw.decode("utf-8-sig"))
        if not isinstance(value, dict):
            raise Stop(reason)
        return value, raw
    except (OSError, UnicodeError, ValueError):
        raise Stop(reason) from None


def valid_identity(value, allow_empty=False):
    return (isinstance(value, dict) and set(value) == {"bytes", "sha256"}
            and type(value["bytes"]) is int and value["bytes"] >= (0 if allow_empty else 1)
            and isinstance(value["sha256"], str) and re.fullmatch(r"[0-9a-fA-F]{64}", value["sha256"]))


def evidence_path(value):
    if not isinstance(value, str) or not value:
        raise Stop("acceptance_path")
    base = workspace()
    path = Path(value)
    path = path if path.is_absolute() else base / path
    resolved = path.resolve()
    if (path.is_symlink() or path.name.casefold() == "credentials.json"
            or not resolved.is_relative_to(base) or not resolved.is_relative_to((base / "docs/evidence").resolve())):
        raise Stop("acceptance_path")
    return resolved


def read_release(filename):
    path = Path(filename)
    if path.is_symlink() or path.name.casefold() == "credentials.json":
        raise Stop("metadata_path")
    data, _ = json_file(path, "release_invalid")
    version_key(data.get("version"))
    package, acceptance = data.get("package"), data.get("acceptance")
    if (not isinstance(package, dict) or set(package) != {"bytes", "sha256", "members"}
            or not valid_identity({k: package.get(k) for k in ("bytes", "sha256")})
            or not isinstance(package["members"], dict) or set(package["members"]) != MEMBER_PATHS
            or any(not valid_identity(v, allow_empty=True) for v in package["members"].values())):
        raise Stop("release_package_invalid")
    if (not isinstance(acceptance, dict) or set(acceptance) != {"path", "bytes", "sha256"}
            or not valid_identity({k: acceptance.get(k) for k in ("bytes", "sha256")})):
        raise Stop("acceptance_invalid")
    # The independent, fixed project pointer is the trust anchor, not a claim in the manifest.
    pointer_path = evidence_path("docs/evidence/当前试用候选.json")
    pointer, _ = json_file(pointer_path, "acceptance_invalid")
    anchor = pointer.get("receipt")
    if (pointer.get("status") != "DELIVERED_VERIFIED_WITH_DEFERRED_PLATFORM_VALIDATION"
            or pointer.get("currentRequestComplete") is not True or not isinstance(anchor, dict)
            or local_version(pointer.get("version")) != data["version"]):
        raise Stop("acceptance_invalid")
    if (evidence_path(anchor.get("path")) != evidence_path(acceptance["path"])
            or anchor.get("bytes") != acceptance["bytes"] or not isinstance(anchor.get("sha256"), str)
            or anchor["sha256"].lower() != acceptance["sha256"].lower()):
        raise Stop("acceptance_binding")
    receipt, raw = json_file(evidence_path(acceptance["path"]), "acceptance_invalid")
    if (len(raw) != acceptance["bytes"] or digest(raw) != acceptance["sha256"].lower()
            or receipt.get("status") != "DELIVERED_VERIFIED_WITH_DEFERRED_PLATFORM_VALIDATION"
            or local_version(receipt.get("version")) != data["version"]):
        raise Stop("acceptance_invalid")
    approved = receipt.get("packages")
    if not isinstance(approved, list) or not any(
            isinstance(p, dict) and str(p.get("path", "")).lower().endswith(".zip")
            and p.get("bytes") == package["bytes"] and isinstance(p.get("sha256"), str)
            and p["sha256"].lower() == package["sha256"].lower() for p in approved):
        raise Stop("acceptance_package")
    return data


def check_name(name):
    parts = name.split("/")
    if (not name or any(c in name for c in '\\:*?"<>|') or any(ord(c) < 32 for c in name) or name.startswith("/")
            or any(p in ("", ".", "..") or p.rstrip(" .") != p for p in parts)):
        raise Stop("unsafe_member_path")


def read_package(filename, package):
    p = Path(filename)
    if not p.is_file() or p.is_symlink() or p.stat().st_size != package["bytes"]:
        raise Stop("zip_identity")
    raw = p.read_bytes()
    if len(raw) != package["bytes"] or digest(raw) != package["sha256"].lower():
        raise Stop("zip_identity")
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            entries = z.infolist()
            if len(entries) != 24:
                raise Stop("member_count")
            files = {}
            folded = set()
            for item in entries:
                name = item.filename
                check_name(name)
                if (name != item.orig_filename or name.casefold() in folded or item.is_dir()
                        or stat.S_ISLNK(item.external_attr >> 16) or item.flag_bits & 1):
                    raise Stop("unsafe_member_path")
                folded.add(name.casefold())
                expected = package["members"].get(name)
                if not expected or item.file_size != expected["bytes"]:
                    raise Stop("member_identity")
                data = z.read(item)
                if len(data) != expected["bytes"] or digest(data) != expected["sha256"].lower():
                    raise Stop("member_identity")
                files[name] = data
            if set(files) != MEMBER_PATHS:
                raise Stop("member_identity")
            return files
    except (zipfile.BadZipFile, RuntimeError, ValueError):
        raise Stop("zip_unreadable") from None


def read_metadata(data):
    fixed = {"owner": OWNER, "slug": SLUG, "displayName": NAME}
    optional = {"summary", "description", "tags", "license", "homepage"}
    required = {"version", "iconUrl", "category", "subCategories", "summaryZh", "changelog"}
    if not isinstance(data, dict) or set(data) - (set(fixed) | optional | required | {"package", "acceptance"}):
        raise Stop("metadata_fields")
    for key, value in fixed.items():
        if data.get(key) != value:
            raise Stop("metadata_" + key)
    version_key(data.get("version"))
    for key in ("iconUrl", "category", "summaryZh", "changelog"):
        if not isinstance(data.get(key), str) or not data[key].strip():
            raise Stop("metadata_" + key)
    icon = urllib.parse.urlsplit(data["iconUrl"])
    if icon.scheme != "https" or not icon.hostname or icon.username or icon.password or icon.fragment:
        raise Stop("metadata_iconUrl")
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", data["category"]):
        raise Stop("metadata_category")
    subs = data.get("subCategories")
    if (not isinstance(subs, list) or not 1 <= len(subs) <= 3
            or any(not isinstance(s, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", s) for s in subs)
            or len(set(subs)) != len(subs)):
        raise Stop("metadata_subCategories")
    result = {k: data[k] for k in fixed if k != "owner"}
    result.update({k: data[k] for k in required})
    for key in optional:
        value = data.get(key)
        if value is None or value == "" or value == []:
            continue
        if key == "tags":
            if not isinstance(value, list) or any(not isinstance(t, str) or not t.strip() for t in value):
                raise Stop("metadata_tags")
        elif not isinstance(value, str) or not value.strip():
            raise Stop("metadata_" + key)
        result[key] = value
    return result


def multipart(payload, files):
    boundary = "----agentCoach" + uuid.uuid4().hex
    body = bytearray()
    for field, filename, data in [("payload", None, json.dumps(payload, ensure_ascii=False).encode("utf-8"))] + [
            ("files", name, data) for name, data in files.items()]:
        body.extend(("--" + boundary + "\r\n").encode())
        disposition = 'Content-Disposition: form-data; name="' + field + '"'
        if filename:
            disposition += '; filename="' + filename + '"'
        body.extend((disposition + "\r\nContent-Type: " +
                     ("application/json" if filename is None else "application/octet-stream") + "\r\n\r\n").encode("utf-8"))
        body.extend(data + b"\r\n")
    body.extend(("--" + boundary + "--\r\n").encode())
    content_type = "multipart/form-data; boundary=" + boundary
    message = BytesParser(policy=policy.default).parsebytes(
        ("Content-Type: " + content_type + "\r\nMIME-Version: 1.0\r\n\r\n").encode() + body)
    parts = list(message.iter_parts())
    if message.defects or len(parts) != 25 or parts[0].get_param("name", header="content-disposition") != "payload":
        raise Stop("multipart_invalid")
    if json.loads(parts[0].get_payload(decode=True)) != payload:
        raise Stop("multipart_invalid")
    received = {}
    for part in parts[1:]:
        if part.get_param("name", header="content-disposition") != "files":
            raise Stop("multipart_invalid")
        name = part.get_filename()
        if name in received:
            raise Stop("multipart_invalid")
        received[name] = part.get_payload(decode=True)
    if received != files:
        raise Stop("multipart_invalid")
    return bytes(body), content_type


def exchange(method, path, token, data=None, content_type=None):
    allowed = {("GET", "/api/v1/auth/me"), ("GET", "/api/v1/skills/agent-coach"),
               ("GET", "/api/v1/skills/agent-coach/versions"), ("POST", "/api/v1/community/skills/publish")}
    if (method, path) not in allowed:
        raise Stop("api_target_invalid")
    headers = {"Authorization": "Bearer " + token, "Accept": "application/json",
               "User-Agent": "agent-coach-sidecar-publisher"}
    if content_type:
        headers["Content-Type"] = content_type
    request = urllib.request.Request(API + path, data=data, method=method, headers=headers)
    opener = urllib.request.build_opener(NoRedirect())
    try:
        with opener.open(request, timeout=60) as response:
            status, raw = response.status, response.read(1024 * 1024 + 1)
    except urllib.error.HTTPError as error:
        status, raw = error.code, error.read(1024 * 1024 + 1)
    except (urllib.error.URLError, OSError, TimeoutError):
        raise Stop("network_unavailable") from None
    if type(status) is not int or not 100 <= status <= 599:
        raise Stop("response_invalid")
    if len(raw) > 1024 * 1024:
        raise Stop("response_too_large")
    try:
        value = json.loads(raw)
    except (ValueError, UnicodeError):
        raise Stop("response_invalid") from None
    if not isinstance(value, dict):
        raise Stop("response_invalid")
    return status, value


def load_user():
    # This function is called only after --submit and never uses environment tokens.
    try:
        saved = json.loads(CREDENTIALS.read_text(encoding="utf-8"))
        user = saved["user"]
        token = user["token"]
        if (not isinstance(token, str) or not token.startswith("skh_")
                or not all(32 < ord(c) < 127 for c in token)):
            raise Stop("credentials_missing")
        if user.get("host", "").rstrip("/") != API:
            raise Stop("credentials_host")
        if user.get("handle") != OWNER:
            raise Stop("owner_conflict")
        if type(user.get("userId")) is not int or user["userId"] <= 0:
            raise Stop("credentials_missing")
        return user
    except (KeyError, TypeError, OSError, UnicodeError, ValueError):
        raise Stop("credentials_missing") from None


def get_json(path, token):
    status, value = exchange("GET", path, token)
    if status != 200:
        raise Stop("preflight_http_rejected")
    return value


def check_existing(detail, payload):
    skill, owner, namespace = detail.get("skill"), detail.get("owner"), detail.get("namespace")
    if (not all(isinstance(x, dict) for x in (skill, owner, namespace))
            or owner.get("handle") != OWNER or namespace.get("handle") != OWNER
            or namespace.get("publicSlug") != SLUG or namespace.get("canonicalName") != "@" + OWNER + "/" + SLUG
            or skill.get("slug") != SLUG or skill.get("displayName") != NAME):
        raise Stop("target_conflict")
    if skill.get("iconUrl") != payload["iconUrl"]:
        raise Stop("icon_conflict")
    latest = detail.get("latestVersion")
    if not isinstance(latest, dict):
        raise Stop("public_version_unverified")
    if version_key(latest.get("version")) >= version_key(payload["version"]):
        raise Stop("version_conflict")
    subs = skill.get("subCategories")
    if (not isinstance(skill.get("category"), str) or not skill["category"].strip()
            or not isinstance(skill.get("summary_zh"), str) or not skill["summary_zh"].strip()
            or not isinstance(subs, list) or not subs
            or any(not isinstance(s, dict) or not isinstance(s.get("key"), str) or not s["key"] for s in subs)):
        raise Stop("original_metadata_missing")
    expected = {"category": skill["category"], "subCategories": [s["key"] for s in subs],
                "summaryZh": skill["summary_zh"]}
    for key, value in expected.items():
        if payload[key] != value:
            raise Stop("metadata_conflict_" + key)
    for key in ("summary", "description", "license", "homepage", "tags"):
        original = skill.get(key)
        if key == "tags" and isinstance(original, dict):
            if key in payload:
                raise Stop("optional_metadata_unverified")
            continue  # The public latest-version map is not a writable tags array.
        if original not in (None, "", []) and payload.get(key) != original:
            raise Stop("optional_metadata_unverified")
        if key in payload and original in (None, "", []):
            raise Stop("optional_metadata_unverified")


def submission_receipt(version):
    base = workspace()
    directory = base / RECEIPTS
    if not directory.resolve().is_relative_to(base):
        raise Stop("receipt_path")
    for parent in (directory, *directory.parents):
        if parent == base:
            break
        if parent.is_symlink() or parent.is_junction():
            raise Stop("receipt_path")
    # Build metadata does not create a different SemVer identity or a new attempt slot.
    return directory / (SLUG + "-" + version.split("+", 1)[0] + ".submit.json")


def valid_reply(value, payload, user):
    if not isinstance(value, dict) or value.get("status") != "pending_review":
        return False
    identity = value.get("skillId")
    if not ((type(identity) is int and identity > 0) or
            (isinstance(identity, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", identity)
             and "skh_" not in identity.lower() and user["token"] not in identity)):
        return False
    for key in ("slug", "version"):
        if key in value and value[key] != payload[key]:
            return False
    if "owner" in value:
        owner = value["owner"]
        if isinstance(owner, dict):
            if (owner.get("handle") != OWNER or
                    ("id" in owner and (type(owner["id"]) is not int or owner["id"] != user["userId"]))):
                return False
        elif owner != OWNER:
            return False
    if "publicUrl" in value and value["publicUrl"] != PUBLIC_URL:
        return False
    return True


def write_receipt(path, value):
    fd, filename = tempfile.mkstemp(prefix=".publish-receipt-", suffix=".tmp", dir=path.parent)
    temp = Path(filename)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(value, stream, ensure_ascii=False)
        os.replace(temp, path)
    finally:
        if temp.exists():
            temp.unlink()


def submit(payload, body, content_type, zip_sha):
    version = payload["version"]
    if version_key(version) == version_key("1.17.0"):
        raise Stop("target_already_submitted")
    receipt = submission_receipt(version)
    if receipt.exists() or receipt.is_symlink():
        raise Stop("submission_receipt_exists")
    user = load_user()
    token = user["token"]
    me = get_json("/api/v1/auth/me", token)
    me = me.get("user", me)
    user_id = me.get("id", me.get("userId")) if isinstance(me, dict) else None
    if (not isinstance(me, dict) or me.get("handle") != OWNER
            or type(user_id) is not int or user_id != user["userId"]):
        raise Stop("owner_conflict")
    check_existing(get_json("/api/v1/skills/agent-coach", token), payload)
    listed = get_json("/api/v1/skills/agent-coach/versions", token)
    versions = listed.get("versions")
    if (not isinstance(versions, list) or not versions or listed.get("nextCursor")
            or any(not isinstance(v, dict) or not isinstance(v.get("version"), str) for v in versions)):
        raise Stop("versions_unverified")
    if any(version_key(v["version"]) >= version_key(version) for v in versions):
        raise Stop("version_conflict")
    result = {"status": "submission_unknown", "owner": OWNER, "slug": SLUG, "version": version,
              "zipSha256": zip_sha, "publicationVerified": False, "reason": "attempt_started"}
    try:
        receipt.parent.mkdir(parents=True, exist_ok=True)
        with receipt.open("x", encoding="utf-8") as stream:
            json.dump(result, stream)
    except FileExistsError:
        raise Stop("submission_receipt_exists") from None
    except OSError:
        raise Stop("receipt_not_writable") from None
    code = 3
    try:
        status, value = exchange("POST", "/api/v1/community/skills/publish", token, body, content_type)
        if type(status) is not int:
            raise Stop("response_invalid")
        result["httpStatus"] = status
        if 200 <= status < 300 and valid_reply(value, payload, user):
            result.update(status="submitted_pending_review", skillId=value["skillId"], reason="submission_acknowledged")
            code = 0
        elif status == 409:
            result.update(status="submission_conflict", reason="http_conflict")
        else:
            result["reason"] = "response_not_verified"
    except Exception:
        # The POST may have reached the server. Never infer absence from public versions.
        result["reason"] = "post_result_unknown"
    try:
        write_receipt(receipt, result)
    except OSError:
        result.update(status="submission_unknown", reason="receipt_update_failed")
        code = 3
    return result, code


def main(argv=None):
    try:
        parser = QuietParser(description=__doc__)
        parser.add_argument("zip", help="Reviewed original ZIP")
        parser.add_argument("--metadata", required=True, help="Accepted sidecar release manifest, kept outside the ZIP")
        parser.add_argument("--submit", action="store_true", help="One explicitly requested submission; known 1.17.0 is permanently blocked")
        args = parser.parse_args(argv)
        release = read_release(args.metadata)
        payload = read_metadata(release)
        files = read_package(args.zip, release["package"])
        body, content_type = multipart(payload, files)
        manifest = [{"path": name, "bytes": len(data), "sha256": digest(data)} for name, data in sorted(files.items())]
        if args.submit:
            result, code = submit(payload, body, content_type, release["package"]["sha256"].lower())
        else:
            result = {"mode": "preflight", "status": "offline_validated", "owner": OWNER,
                      "slug": SLUG, "version": payload["version"], "iconUrl": payload["iconUrl"],
                      "zipSha256": release["package"]["sha256"].lower(),
                      "fileCount": len(files), "contentDigest": digest(json.dumps(manifest, ensure_ascii=False).encode()),
                      "multipartBytes": len(body), "files": manifest}
            code = 0
        print(json.dumps(result, ensure_ascii=False))
        return code
    except Stop as error:
        print(json.dumps({"status": "blocked", "reason": str(error)}))
        return 1
    except Exception:
        print(json.dumps({"status": "blocked", "reason": "internal_error"}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
