"""Publish the reviewed agent-coach ZIP with sidecar metadata; offline by default.

Protocol: https://skillhub.cn/ai/release.md and official CLI 2026.8.5.
Never import the global CLI or rewrite the ZIP. Real submission belongs to the controller.
"""

import argparse
import hashlib
import io
import json
from pathlib import Path
import stat
import sys
import uuid
import zipfile
from email import policy
from email.parser import BytesParser
import urllib.error
import urllib.request

API = "https://api.skillhub.cn"
OWNER = "user_0fdf85d4"
SLUG = "agent-coach"
VERSION = "1.17.0"
NAME = "Agent 搭建教练"
ICON = "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/27205dc2-3c4b-4854-85b1-8902f05745a3.png"
ZIP_SIZE = 97352
ZIP_SHA = "b67ba49e53df0287ee2815037de82a0d3690d7cddb0a23aa3e2064cab2a1e5b1"
CREDENTIALS = Path.home() / ".skillhub" / "credentials.json"
MEMBERS = {
    'SKILL.md': (1112, 'ae80dd40f98870497fceb059f93e7c17c827e001b811b6478865383ad6aa6489'),
    'AGENTS.md': (4296, '69beec1a4290df5ad55b7a48f451bed3fd53c08b323d6a1d319cee7f5bb586b7'),
    'CLAUDE.md': (11, '336cc4fbf19beaada7ccf9986414fa91851a8d7a07dfb3ccbe800a69eed0ab49'),
    'README.md': (5113, 'aef2e521f018bdfebe20e6ee0107e82efc5001b15e25c2f43ebdb5253dee6a48'),
    '做法/1-建项目.md': (4300, 'f28a32cd1cb2738011f9aba79ca2fe916d45bc93bcaefae3a506904c36cc2f37'),
    '模板/AGENTS.模板.md': (11973, '68662efb6545f79ab3665186ff0fcef621a60c805ff2027f1d898d9a6e3a1c0c'),
    '模板/CLAUDE.模板.md': (11, '336cc4fbf19beaada7ccf9986414fa91851a8d7a07dfb3ccbe800a69eed0ab49'),
    '模板/README.模板.md': (342, 'ef77073c24bf5790db7668c0e0d1ec1fd2115e6ccf122ecd4c65c3a31659d9c7'),
    '模板/docs/PROJECT_INDEX.模板.md': (2409, '3cfe6b9e1f2dfbf4423f4c71724a1e9601bef4b694a308be639a1a951aabeb03'),
    '工具/coach-check.mjs': (128327, 'fc5c035055404bda8db2cec7246bd0d09e7756998ec7c5d15eabca3b1c8fb804'),
    '做法/共用.md': (5988, 'b9d878716d15945453c8023caafe51b82d24bed4388ae2301c99bae39f8829bb'),
    '讲解/五站总览.html': (8532, 'd5212dbd8f295c6d68f6c9d5c8a281d57277ba627d31840607ab6bc2e6942f94'),
    '做法/0-体检.md': (6359, 'ec29bfc8a6a0c157ef29c147078842397a7b9765c6993a7c25f35cfe64eb8bcf'),
    '做法/0-修复复诊.md': (5819, '5f04833301f17993897c07a060150bca51438cd7fdc42f543d79d9acaa086a3d'),
    '做法/2-新做-说清需求.md': (4435, '9162d3eb769ac51835a1f7ab3167281d35846d613a0b687378dbb12e1b90bcc7'),
    '做法/2-SOP-拆开SOP.md': (4131, '0cb0ee095211e3ab957a640a268726e4dcd31be3d10a5c469c17ee3ee869bec2'),
    '做法/3-排表画图.md': (5397, '9af381115711fdf83d803edb9c98e291b39d70911ec1601f71f639441f6130cf'),
    '做法/4-一步一票.md': (5520, '436b62b1d2796023366a2fc7ee58c79c66b8e265a8c5cc3df58a897e6bceaee0'),
    '做法/5-收尾交接.md': (5440, 'bf866e0d8cba079d1b4f505f5abf84cc635c45714a14a2064913d907a1d6a71c'),
    '做法/架构推荐表.md': (3755, '6656535f5e30499a366489ee8cff0a2e0aa71b244ed8ca056b6b127399895246'),
    '模板/docs/INTAKE-新做.模板.md': (2366, '64811cadbbab9fd91a1515934f732c18c1a4bf757b9999094927bfa3edb2d5b9'),
    '模板/docs/INTAKE-SOP.模板.md': (1318, 'e74b0c8cee10564fae7882dbfd9204d780e4791672ff8d52ac2e5529d845d866'),
    '模板/docs/run-flow.模板.md': (1308, '04c74f28d9ec88e6e1b97ac95b378ce4bada028badfc887f882bdca3b12407ab'),
    '模板/docs/票.模板.md': (2876, '45b291bf8ffdfbd2fdfd0fc34b1d56fb698edb2c6eabf2bcc824a380df1a9b02'),
}


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


def check_name(name):
    parts = name.split("/")
    if (not name or any(c in name for c in '\\:"\r\n\0') or name.startswith("/")
            or any(p in ("", ".", "..") or p.rstrip(" .") != p for p in parts)):
        raise Stop("unsafe_member_path")


def read_package(filename):
    p = Path(filename)
    if not p.is_file() or p.is_symlink() or p.stat().st_size != ZIP_SIZE:
        raise Stop("zip_identity")
    raw = p.read_bytes()
    if len(raw) != ZIP_SIZE or digest(raw) != ZIP_SHA:
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
                expected = MEMBERS.get(name)
                if not expected or item.file_size != expected[0]:
                    raise Stop("member_identity")
                data = z.read(item)
                if len(data) != expected[0] or digest(data) != expected[1]:
                    raise Stop("member_identity")
                files[name] = data
            if set(files) != set(MEMBERS):
                raise Stop("member_identity")
            return files
    except (zipfile.BadZipFile, RuntimeError, ValueError):
        raise Stop("zip_unreadable") from None


def read_metadata(filename):
    p = Path(filename)
    if p.is_symlink() or p.name.casefold() == "credentials.json":
        raise Stop("metadata_path")
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError):
        raise Stop("metadata_invalid") from None
    fixed = {"owner": OWNER, "slug": SLUG, "version": VERSION, "displayName": NAME, "iconUrl": ICON}
    optional = {"summary", "description", "tags", "license", "homepage"}
    if not isinstance(data, dict) or set(data) - (set(fixed) | optional | {"changelog"}):
        raise Stop("metadata_fields")
    for key, value in fixed.items():
        if data.get(key) != value:
            raise Stop("metadata_" + key)
    if not isinstance(data.get("changelog"), str) or not data["changelog"].strip():
        raise Stop("metadata_changelog")
    result = {k: data[k] for k in fixed if k != "owner"}
    result["changelog"] = data["changelog"]
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
    raise Stop("submit_unavailable")


def submit(payload, files, body, content_type, metadata_path):
    # Safe functional baseline: no credential reads or network until implemented and reviewed.
    raise Stop("submit_unavailable")


def main(argv=None):
    try:
        parser = QuietParser(description=__doc__)
        parser.add_argument("zip", help="Reviewed original ZIP")
        parser.add_argument("--metadata", required=True, help="Sidecar JSON, kept outside the ZIP")
        parser.add_argument("--submit", action="store_true", help="One submission; requires prior controller review")
        args = parser.parse_args(argv)
        files = read_package(args.zip)
        payload = read_metadata(args.metadata)
        body, content_type = multipart(payload, files)
        manifest = [{"path": name, "bytes": len(data), "sha256": digest(data)} for name, data in sorted(files.items())]
        if args.submit:
            result, code = submit(payload, files, body, content_type, Path(args.metadata))
        else:
            result = {"mode": "preflight", "status": "offline_validated", "owner": OWNER,
                      "slug": SLUG, "version": VERSION, "iconUrl": ICON, "zipSha256": ZIP_SHA,
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
