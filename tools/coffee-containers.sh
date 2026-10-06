#!/usr/bin/env bash
# Локальное управление существующими контейнерами; без deployment и удаления данных.
set -euo pipefail

usage() {
  echo 'coffee-containers <platform|legacy|db|n8n|gitea> <status|start|stop|remove>'
  echo 'legacy не включает общий PostgreSQL; start legacy запускает только существующий API.'
  echo 'remove требует сначала stop и сохраняет все volumes. Новые контейнеры не создаются.'
}

if [[ $# == 0 || ${1:-} == --help ]]; then usage; exit 0; fi
if [[ $# != 2 ]]; then usage >&2; exit 2; fi
group=$1
action=$2
case "$action" in status|start|stop|remove) ;; *) usage >&2; exit 2 ;; esac
filters=()
case "$group" in
  platform) filters+=(--filter label=com.docker.compose.project=coffee-platform) ;;
  legacy|db)
    filters+=(--filter label=com.docker.compose.project=coffeeordersystem)
    if [[ $group == db ]]; then filters+=(--filter label=com.docker.compose.service=postgres); fi
    if [[ $group == legacy && $action == start ]]; then filters+=(--filter label=com.docker.compose.service=api); fi
    ;;
  n8n) filters+=(--filter label=com.docker.compose.project=n8n) ;;
  gitea) filters+=(--filter label=com.docker.compose.project=gitea-test) ;;
  *) usage >&2; exit 2 ;;
esac

rows=$(docker ps --all "${filters[@]}" --format '{{.ID}} {{.Label "com.docker.compose.service"}}')
if [[ $group == legacy ]]; then rows=$(awk '$2 != "postgres" {print $0}' <<< "$rows"); fi
ids=()
while read -r id service; do
  if [[ -n $id ]]; then ids+=("$id"); fi
done <<< "$rows"
if [[ ${#ids[@]} == 0 ]]; then
  echo "В группе $group нет существующих контейнеров; для создания нужен отдельный Compose-запуск."
  if [[ $action == start ]]; then exit 1; fi
  exit 0
fi

case "$action" in
  status) docker inspect --format '{{.Name}} | {{.State.Status}} | {{if .State.Health}}{{.State.Health.Status}}{{end}}' "${ids[@]}" ;;
  start) docker start "${ids[@]}" ;;
  stop) docker stop --time 30 "${ids[@]}" ;;
  remove)
    running=$(docker inspect --format '{{.State.Running}}' "${ids[@]}")
    if [[ $running == *true* ]]; then
      echo "Сначала выполните: coffee-containers $group stop. Volumes не удаляются." >&2
      exit 1
    fi
    docker container rm "${ids[@]}"
    ;;
esac
