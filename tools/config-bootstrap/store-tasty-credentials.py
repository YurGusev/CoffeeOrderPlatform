#!/usr/bin/python3
"""Скрытый локальный ввод учётных данных Tasty Coffee в SOPS."""

import getpass
import json
from pathlib import Path
import subprocess
import warnings


def read_hidden(label):
    while True:
        value = getpass.getpass(f"Tasty Coffee — {label} (ввод скрыт): ")
        if value.strip() and "\0" not in value:
            return value
        print(f"Поле «{label}» пустое или содержит NUL. Введите его ещё раз.")


def main():
    warnings.simplefilter("error", getpass.GetPassWarning)
    try:
        login = read_hidden("логин")
        password = read_hidden("пароль")
    except (EOFError, KeyboardInterrupt, getpass.GetPassWarning):
        raise SystemExit(
            "Скрытый ввод прерван. Запустите команду в интерактивном терминале."
        ) from None

    root = Path(__file__).resolve().parents[2]
    try:
        subprocess.run(
            [
                "sops", "set", "--value-stdin",
                str(root / "secrets/platform.secrets.sops.yaml"),
                '["environments"]["development"]["tasty"]',
            ],
            input=json.dumps({"login": login, "password": password}),
            text=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=True,
        )
    except (OSError, subprocess.CalledProcessError):
        raise SystemExit(
            "SOPS не записал данные. Проверьте наличие sops и доступ к age identity."
        ) from None
    print("Учётные данные Tasty Coffee сохранены в SOPS.")


if __name__ == "__main__":
    main()
