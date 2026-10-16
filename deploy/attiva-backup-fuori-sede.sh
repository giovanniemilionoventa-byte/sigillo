#!/bin/sh
# Guided, one-time setup of the off-site backup, with a restore proof at the end.
#
# Run it once on the HOST (not in the container), as root, from this folder:
#
#   sudo ./attiva-backup-fuori-sede.sh
#
# What it does, so that nobody has to do these steps by hand
# (docs/DEPLOY-PRODUZIONE.md, 6.1):
#   1. installs `age` and `rclone` if they are missing;
#   2. connects the storage you name (SFTP or S3-compatible) as the rclone
#      remote "box";
#   3. generates the encryption key pair, shows the PRIVATE key once, and asks
#      you to type its last six characters back, which proves you saved it;
#   4. writes /etc/sigillo-offsite.env (public key and destination only);
#   5. takes a backup, encrypts it, uploads it, downloads it again, decrypts it
#      and opens the database: only if all of that works does it print
#      "backup fuori sede attivo e provato";
#   6. removes the private key from this server, and installs the two cron jobs
#      (hourly backup, daily upload). Running it again replaces them, it never
#      adds a second copy.
#
# The private key therefore exists on this server only for the minutes of this
# setup, in a private folder that is erased on exit. After that the server can
# write backups but never read them.
#
# Every answer can also be given up front through an environment variable
# (SIGILLO_SETUP_*, below), which is how the tests drive it.
#   SIGILLO_SETUP_KIND          sftp | s3
#   SIGILLO_SETUP_HOST          sftp: host name; s3: endpoint URL
#   SIGILLO_SETUP_USER          sftp: user;      s3: access key id
#   SIGILLO_SETUP_PASSWORD      sftp: password;  s3: secret access key
#   SIGILLO_SETUP_PATH          folder (sftp) or bucket (s3) to keep the copies in
#   SIGILLO_SETUP_CONFIRM_KEY   the last six characters of the private key
#   SIGILLO_SETUP_SKIP_CRON     set to 1 to leave cron alone
#   SIGILLO_SETUP_SKIP_INSTALL  set to 1 to not run apt-get
#   SIGILLO_SETUP_IDENTITY      tests only: an existing age key file to use
#   SIGILLO_OFFSITE_SOURCE      a backup file to use instead of asking the
#                               server container for a fresh one (tests)

set -eu

ENV_FILE="${SIGILLO_OFFSITE_ENV:-/etc/sigillo-offsite.env}"
HERE="$(cd "$(dirname "$0")" && pwd)"

say() { printf '%s\n' "$*"; }
fail() { say "ERRORE: $*" >&2; exit 1; }

ask() { # ask VARIABLE "question" [secret]
	_var="$1"; _question="$2"; _secret="${3:-}"
	eval "_current=\${$_var:-}"
	[ -n "$_current" ] && return 0
	printf '%s ' "$_question" >&2
	[ -n "$_secret" ] && stty -echo 2>/dev/null || true
	read -r _answer || fail "nessuna risposta per: $_question"
	[ -n "$_secret" ] && { stty echo 2>/dev/null || true; printf '\n' >&2; }
	[ -n "$_answer" ] || fail "risposta vuota per: $_question"
	eval "$_var=\$_answer"
}

WORK=$(mktemp -d)
chmod 700 "$WORK"
# The private key lives only in $WORK, and $WORK is erased however this ends.
trap 'rm -rf "$WORK"' EXIT INT TERM

if [ "${SIGILLO_SETUP_SKIP_INSTALL:-}" != 1 ]; then
	[ "$(id -u)" -eq 0 ] || fail "lancialo come root: sudo ./attiva-backup-fuori-sede.sh"
	if ! command -v age >/dev/null 2>&1 || ! command -v rclone >/dev/null 2>&1; then
		say "Installo age e rclone..."
		apt-get install -y age rclone >/dev/null || fail "non riesco a installare age e rclone con apt-get"
	fi
fi
for tool in age age-keygen rclone python3; do
	command -v "$tool" >/dev/null 2>&1 || fail "manca il programma $tool"
done

# ---- 1. the storage -------------------------------------------------------
say ""
say "Dove metto le copie? 1 = server SFTP (per esempio una Storage Box)  2 = deposito S3 (bucket)"
ask SIGILLO_SETUP_KIND "Scegli sftp o s3:"
case "$SIGILLO_SETUP_KIND" in
	sftp)
		ask SIGILLO_SETUP_HOST "Nome del server (per esempio u123456.your-storagebox.de):"
		ask SIGILLO_SETUP_USER "Utente:"
		ask SIGILLO_SETUP_PASSWORD "Password (non si vede mentre la scrivi):" secret
		ask SIGILLO_SETUP_PATH "Cartella dove tenere le copie (per esempio sigillo):"
		rclone config create box sftp host "$SIGILLO_SETUP_HOST" user "$SIGILLO_SETUP_USER" pass "$SIGILLO_SETUP_PASSWORD" >/dev/null
		REMOTE="box:$SIGILLO_SETUP_PATH"
		;;
	s3)
		ask SIGILLO_SETUP_HOST "Indirizzo del deposito (endpoint, https://...):"
		ask SIGILLO_SETUP_USER "Access key id:"
		ask SIGILLO_SETUP_PASSWORD "Secret access key (non si vede mentre la scrivi):" secret
		ask SIGILLO_SETUP_PATH "Nome del bucket:"
		rclone config create box s3 provider Other endpoint "$SIGILLO_SETUP_HOST" access_key_id "$SIGILLO_SETUP_USER" secret_access_key "$SIGILLO_SETUP_PASSWORD" >/dev/null
		REMOTE="box:$SIGILLO_SETUP_PATH/sigillo"
		;;
	*) fail "rispondi sftp oppure s3" ;;
esac
# The credentials were handed to rclone, which keeps them in its own config.
unset SIGILLO_SETUP_PASSWORD

# ---- 2. the key pair ------------------------------------------------------
IDENTITY="$WORK/chiave-privata.txt"
if [ -n "${SIGILLO_SETUP_IDENTITY:-}" ]; then
	cp "$SIGILLO_SETUP_IDENTITY" "$IDENTITY" # tests only: a key pair made beforehand
else
	age-keygen -o "$IDENTITY" >/dev/null 2>&1
fi
RECIPIENT=$(age-keygen -y "$IDENTITY")
SECRET=$(grep '^AGE-SECRET-KEY-' "$IDENTITY")
TAIL=$(printf '%s' "$SECRET" | tail -c 6)

say ""
say "================================================================"
say "QUESTA È LA CHIAVE PRIVATA. Compare una volta sola."
say "Copiala ora nel gestore di password (e se vuoi su carta)."
say "Senza di lei le copie non si aprono mai più."
say ""
say "  $SECRET"
say "================================================================"
ask SIGILLO_SETUP_CONFIRM_KEY "Per conferma scrivi gli ultimi 6 caratteri della chiave:"
[ "$SIGILLO_SETUP_CONFIRM_KEY" = "$TAIL" ] || fail "gli ultimi 6 caratteri non coincidono: non vado avanti senza la certezza che hai salvato la chiave"

# ---- 3. the settings ------------------------------------------------------
umask 077
{
	echo "SIGILLO_OFFSITE_RECIPIENT=$RECIPIENT"
	echo "SIGILLO_OFFSITE_REMOTE=$REMOTE"
	echo "SIGILLO_OFFSITE_KEEP=30"
} > "$ENV_FILE"

# ---- 4. the proof ---------------------------------------------------------
say ""
say "Provo tutto il giro: copia, invio, scarico, decifratura, apertura del database..."
if [ -z "${SIGILLO_OFFSITE_SOURCE:-}" ]; then
	(cd "$HERE" && docker compose exec -T server /app/backup.sh) >/dev/null || fail "il backup del database non è riuscito (vedi docs/DEPLOY-PRODUZIONE.md, 6.1)"
fi
UPLOAD=$(SIGILLO_OFFSITE_ENV="$ENV_FILE" sh "$HERE/offsite-backup.sh") || fail "l'invio fuori sede non è riuscito"
NAME=$(printf '%s\n' "$UPLOAD" | sed -n 's/^uploaded \(sigillo-[^ ]*\.db\.age\) .*/\1/p' | head -n 1)
[ -n "$NAME" ] || fail "non trovo il nome della copia inviata"

rclone copyto "$REMOTE/$NAME" "$WORK/$NAME" || fail "non riesco a riscaricare la copia dal deposito"
age -d -i "$IDENTITY" -o "$WORK/ripristino.db" "$WORK/$NAME" || fail "la copia scaricata non si apre con la chiave"
python3 -I - "$WORK/ripristino.db" <<'PY' || fail "la copia si apre ma il database è danneggiato"
import sqlite3, sys
db = sqlite3.connect("file:" + sys.argv[1] + "?mode=ro", uri=True)
result = db.execute("PRAGMA integrity_check").fetchone()[0]
tables = db.execute("SELECT count(*) FROM sqlite_master WHERE type = 'table'").fetchone()[0]
if result != "ok" or tables == 0:
    sys.exit(1)
PY

# ---- 5. cron --------------------------------------------------------------
if [ "${SIGILLO_SETUP_SKIP_CRON:-}" != 1 ]; then
	TAB="$WORK/crontab"
	{ crontab -l 2>/dev/null | grep -v '# sigillo-backup$' || true; } > "$TAB"
	{
		echo "0 * * * * cd $HERE && docker compose exec -T server /app/backup.sh >> /srv/sigillo-backup.log 2>&1 # sigillo-backup"
		echo "30 3 * * * $HERE/offsite-backup.sh >> /srv/sigillo-offsite.log 2>&1 # sigillo-backup"
	} >> "$TAB"
	crontab "$TAB"
fi

say ""
say "backup fuori sede attivo e provato"
say "  copia di prova: $NAME, riscaricata, decifrata e aperta"
say "  la chiave privata viene cancellata da questo server adesso: ce l'hai solo tu"
