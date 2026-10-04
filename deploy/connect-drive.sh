#!/bin/bash
# Connects the server to a Google Drive for the off-site backups, in one run
# (docs/DEPLOY-PRODUZIONE.md, 6.1). From the owner's computer, with a tunnel
# so that Google's page can reach the server:
#
#   ssh -L 53682:127.0.0.1:53682 root@get-sigillo.eu
#
# and then, on the server, from the deploy/ directory of the clone:
#
#   ./connect-drive.sh
#
# It installs rclone if it is missing, asks Google for access to a Drive (only
# to the files rclone itself creates, scope drive.file), makes up the password
# the copies are encrypted with and shows it once, runs a first copy, checks
# that the password written down is the right one, and puts the hourly line in
# the crontab, replacing the old one that called backup.sh directly.
#
# Safe to run again: a Drive connection or a password that already exist are
# kept, never replaced. A new password would leave every copy already on Drive
# unreadable.
#
# The messages are for the owner, so they are in Italian.

set -euo pipefail
cd "$(dirname "$0")"
DEPLOY="$(pwd)"
LOG="${SIGILLO_BACKUP_LOG:-$HOME/sigillo-backup.log}"

have_remote() {
	rclone listremotes | grep -qxF "$1:"
}

if ! command -v rclone >/dev/null 2>&1; then
	echo "Installo rclone, lo strumento che carica i file su Drive."
	apt-get install -y unzip curl >/dev/null
	curl -fsSL https://rclone.org/install.sh | bash >/dev/null
fi

if have_remote sigillo-drive; then
	echo "Google Drive è già collegato, lo lascio com'è."
else
	echo
	echo "Ora Google ti chiede il permesso. Qui sotto compare un link che inizia con"
	echo "http://127.0.0.1:53682: aprilo nel browser del tuo computer, entra con"
	echo "l'account Google dove vuoi i backup e premi Consenti."
	echo "Sarà visibile a rclone solo ciò che crea lui, non il resto del tuo Drive."
	echo
	rclone config create sigillo-drive drive scope=drive.file use_trash=false >/dev/null
	echo "Google Drive collegato."
fi

if have_remote sigillo-backup; then
	echo "La cifratura è già impostata: la password resta quella di prima."
else
	password=$(openssl rand -hex 16)
	rclone config create sigillo-backup crypt remote=sigillo-drive:sigillo-backup \
		filename_encryption=off directory_name_encryption=false \
		password="$password" --obscure >/dev/null
	echo
	echo "Questa è la password con cui i backup su Drive sono cifrati."
	echo "Non la ha nessun altro, nemmeno Google: se il server si rompe e l'hai persa,"
	echo "quei backup non si possono più aprire. Copiala ADESSO nel tuo gestore di"
	echo "password, o scrivila su carta."
	echo
	echo "    $password"
	echo
	read -r -p "Quando l'hai salvata premi Invio: " _
	unset password
	clear 2>/dev/null || true
fi

echo
echo "Faccio la prima copia."
"$DEPLOY/backup-offsite.sh"

echo
echo "Ora controllo che la password salvata sia quella giusta."
"$DEPLOY/backup-offsite.sh" --check

# The hourly line: the old one, which called backup.sh in the container
# directly, goes; the new one is added unless it is already there.
line="0 * * * * $DEPLOY/backup-offsite.sh >> $LOG 2>&1"
current=$(crontab -l 2>/dev/null || true)
kept=$(printf '%s\n' "$current" | grep -v '/app/backup\.sh' || true)
if printf '%s\n' "$kept" | grep -qF "$DEPLOY/backup-offsite.sh"; then
	next="$kept"
else
	next=$(printf '%s\n%s' "$kept" "$line")
fi
printf '%s\n' "$next" | sed '/./,$!d' | crontab -

echo
echo "Fatto. Da ora ogni ora il server copia i backup su Drive, cifrati."
echo "Se accenderli, e ogni quanto, lo scegli in Impostazioni."
