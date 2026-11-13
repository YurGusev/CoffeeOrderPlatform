#!/usr/bin/python3
"""Import only a public fixture CA into a private NSS profile."""

import argparse
import ctypes
import json
import os
import stat
import sys


class CertTrust(ctypes.Structure):
    _fields_ = [
        ("ssl_flags", ctypes.c_uint),
        ("email_flags", ctypes.c_uint),
        ("object_signing_flags", ctypes.c_uint),
    ]


class SecItem(ctypes.Structure):
    _fields_ = [
        ("item_type", ctypes.c_uint),
        ("data", ctypes.POINTER(ctypes.c_ubyte)),
        ("length", ctypes.c_uint),
    ]


def require_private_path(path, directory):
    canonical = os.path.realpath(path)
    root = os.path.realpath(directory)
    if os.path.commonpath((canonical, root)) != root or canonical != path:
        raise ValueError("PATH_INVALID")
    info = os.lstat(path)
    if stat.S_ISLNK(info.st_mode) or info.st_uid != os.getuid():
        raise ValueError("PATH_INVALID")
    return info


def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--database", required=True)
    parser.add_argument("--certificate", action="append", required=True)
    args = parser.parse_args()
    if not args.database.startswith("/dev/shm/"):
        raise ValueError("TMPFS_REQUIRED")
    db_info = require_private_path(args.database, "/dev/shm")
    if not stat.S_ISDIR(db_info.st_mode) or stat.S_IMODE(db_info.st_mode) != 0o700:
        raise ValueError("DATABASE_MODE_INVALID")
    for certificate_path in args.certificate:
        cert_info = require_private_path(certificate_path, "/dev/shm")
        if not stat.S_ISREG(cert_info.st_mode) or stat.S_IMODE(cert_info.st_mode) != 0o400:
            raise ValueError("CERTIFICATE_MODE_INVALID")

    nss = ctypes.CDLL("libnss3.so")
    nss.NSS_InitReadWrite.argtypes = [ctypes.c_char_p]
    nss.NSS_InitReadWrite.restype = ctypes.c_int
    nss.NSS_Shutdown.argtypes = []
    nss.NSS_Shutdown.restype = ctypes.c_int
    nss.PK11_GetInternalKeySlot.argtypes = []
    nss.PK11_GetInternalKeySlot.restype = ctypes.c_void_p
    nss.PK11_InitPin.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_char_p]
    nss.PK11_InitPin.restype = ctypes.c_int
    nss.PK11_Authenticate.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p]
    nss.PK11_Authenticate.restype = ctypes.c_int
    nss.CERT_NewTempCertificate.argtypes = [ctypes.c_void_p, ctypes.POINTER(SecItem), ctypes.c_char_p, ctypes.c_int, ctypes.c_int]
    nss.CERT_NewTempCertificate.restype = ctypes.c_void_p
    nss.PK11_ImportCert.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_ulong, ctypes.c_char_p, ctypes.c_int]
    nss.PK11_ImportCert.restype = ctypes.c_int
    nss.CERT_DecodeTrustString.argtypes = [ctypes.POINTER(CertTrust), ctypes.c_char_p]
    nss.CERT_DecodeTrustString.restype = ctypes.c_int
    nss.CERT_GetDefaultCertDB.argtypes = []
    nss.CERT_GetDefaultCertDB.restype = ctypes.c_void_p
    nss.CERT_ChangeCertTrust.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(CertTrust)]
    nss.CERT_ChangeCertTrust.restype = ctypes.c_int
    nss.CERT_GetCertTrust.argtypes = [ctypes.c_void_p, ctypes.POINTER(CertTrust)]
    nss.CERT_GetCertTrust.restype = ctypes.c_int
    nss.CERT_DestroyCertificate.argtypes = [ctypes.c_void_p]
    nss.CERT_DestroyCertificate.restype = None
    nss.PK11_FreeSlot.argtypes = [ctypes.c_void_p]
    nss.PK11_FreeSlot.restype = None

    database_uri = ("sql:" + args.database).encode("utf-8")
    if nss.NSS_InitReadWrite(database_uri) != 0:
        raise ValueError("NSS_INIT_FAILED")
    slot = None
    certificate = None
    try:
        slot = nss.PK11_GetInternalKeySlot()
        if not slot:
            raise ValueError("NSS_SLOT_FAILED")
        if nss.PK11_InitPin(slot, b"", b"") != 0:
            raise ValueError("NSS_PIN_INIT_FAILED")
        if nss.PK11_Authenticate(slot, 1, None) != 0:
            raise ValueError("NSS_AUTH_FAILED")
        for index, certificate_path in enumerate(args.certificate):
            certificate_bytes = open(certificate_path, "rb").read()
            certificate_buffer = (ctypes.c_ubyte * len(certificate_bytes)).from_buffer_copy(certificate_bytes)
            der_item = SecItem(0, ctypes.cast(certificate_buffer, ctypes.POINTER(ctypes.c_ubyte)), len(certificate_bytes))
            certificate = nss.CERT_NewTempCertificate(
                nss.CERT_GetDefaultCertDB(), ctypes.byref(der_item), None, 0, 1
            )
            if not certificate:
                raise ValueError("NSS_CERT_DECODE_FAILED")
            if nss.PK11_ImportCert(
                slot,
                certificate,
                0,
                ("Browser Verification Fixture CA " + str(index + 1)).encode("ascii"),
                0,
            ) != 0:
                raise ValueError("NSS_CERT_IMPORT_FAILED")
            trust = CertTrust()
            if nss.CERT_DecodeTrustString(ctypes.byref(trust), b"C,,") != 0:
                raise ValueError("NSS_TRUST_PARSE_FAILED")
            if nss.CERT_ChangeCertTrust(nss.CERT_GetDefaultCertDB(), certificate, ctypes.byref(trust)) != 0:
                raise ValueError("NSS_TRUST_WRITE_FAILED")
            observed = CertTrust()
            if nss.CERT_GetCertTrust(certificate, ctypes.byref(observed)) != 0:
                raise ValueError("NSS_TRUST_READBACK_FAILED")
            if observed.ssl_flags != trust.ssl_flags:
                raise ValueError("NSS_TRUST_FLAGS_MISMATCH")
            nss.CERT_DestroyCertificate(certificate)
            certificate = None
    finally:
        if certificate:
            nss.CERT_DestroyCertificate(certificate)
        if slot:
            nss.PK11_FreeSlot(slot)
        if nss.NSS_Shutdown() != 0:
            raise ValueError("NSS_SHUTDOWN_FAILED")
    print(json.dumps({"schemaVersion": 1, "status": "PUBLIC_CA_IMPORTED", "sslTrustedCa": True, "certificateCount": len(args.certificate)}))


try:
    main()
except Exception as error:  # emit a closed code, never native error text
    safe = str(error) if str(error) in {
        "PATH_INVALID", "TMPFS_REQUIRED", "DATABASE_MODE_INVALID", "CERTIFICATE_MODE_INVALID",
        "NSS_INIT_FAILED", "NSS_SLOT_FAILED", "NSS_PIN_INIT_FAILED", "NSS_AUTH_FAILED",
        "NSS_CERT_DECODE_FAILED", "NSS_CERT_IMPORT_FAILED", "NSS_TRUST_PARSE_FAILED",
        "NSS_TRUST_WRITE_FAILED", "NSS_TRUST_READBACK_FAILED", "NSS_TRUST_FLAGS_MISMATCH", "NSS_SHUTDOWN_FAILED",
    } else "NSS_FIXTURE_FAILED"
    print(json.dumps({"schemaVersion": 1, "status": safe}))
    sys.exit(1)
