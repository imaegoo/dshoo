package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

// ErrNotFound reports a missing row.
var ErrNotFound = errors.New("store: not found")

// ErrAlreadyInitialized reports that the server already has an account.
var ErrAlreadyInitialized = errors.New("store: already initialized")

// User is one server account.
type User struct {
	ID           int64
	Username     string
	PasswordHash string
	CreatedAt    time.Time
}

// Instance is one registered DeepSeek Harness plugin installation.
type Instance struct {
	ID          string
	UserID      int64
	Key         string
	Name        string
	Hostname    string
	OS          string
	Arch        string
	DSHVersion  string
	PluginVer   string
	Status      string
	ConnectedAt time.Time
	LastSeen    time.Time
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

// Store owns the SQLite database.
type Store struct {
	db *sql.DB
}

// Open creates or opens the database at path, running migrations.
func Open(path string) (*Store, error) {
	if dir := filepath.Dir(path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, fmt.Errorf("create data dir: %w", err)
		}
	}
	dsn := path + "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)&_pragma=synchronous(NORMAL)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	s := &Store{db: db}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := s.migrate(ctx); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

// Close releases the database handle.
func (s *Store) Close() error { return s.db.Close() }

func (s *Store) migrate(ctx context.Context) error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS users (
			id            INTEGER PRIMARY KEY AUTOINCREMENT,
			username      TEXT    NOT NULL UNIQUE,
			password_hash TEXT    NOT NULL,
			created_at    INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS sessions (
			token_hash TEXT    PRIMARY KEY,
			user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			created_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL,
			user_agent TEXT    NOT NULL DEFAULT ''
		)`,
		`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
		`CREATE TABLE IF NOT EXISTS instances (
			id           TEXT    PRIMARY KEY,
			user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			instance_key TEXT    NOT NULL,
			name         TEXT    NOT NULL,
			hostname     TEXT    NOT NULL DEFAULT '',
			os           TEXT    NOT NULL DEFAULT '',
			arch         TEXT    NOT NULL DEFAULT '',
			dsh_version  TEXT    NOT NULL DEFAULT '',
			plugin_ver   TEXT    NOT NULL DEFAULT '',
			status       TEXT    NOT NULL DEFAULT 'offline',
			connected_at INTEGER NOT NULL DEFAULT 0,
			last_seen    INTEGER NOT NULL DEFAULT 0,
			created_at   INTEGER NOT NULL,
			updated_at   INTEGER NOT NULL,
			UNIQUE(user_id, instance_key)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_instances_user ON instances(user_id)`,
	}
	for _, stmt := range stmts {
		if _, err := s.db.ExecContext(ctx, stmt); err != nil {
			return fmt.Errorf("migrate: %w", err)
		}
	}
	return nil
}

func unix(t time.Time) int64 { return t.UTC().Unix() }

func fromUnix(v int64) time.Time {
	if v == 0 {
		return time.Time{}
	}
	return time.Unix(v, 0).UTC()
}

// CountUsers reports how many accounts exist.
func (s *Store) CountUsers(ctx context.Context) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM users`).Scan(&n)
	return n, err
}

// CreateUser inserts one account with an already-hashed password.
func (s *Store) CreateUser(ctx context.Context, username, passwordHash string) (User, error) {
	now := time.Now().UTC()
	res, err := s.db.ExecContext(ctx,
		`INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)`,
		username, passwordHash, unix(now))
	if err != nil {
		return User{}, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return User{}, err
	}
	return User{ID: id, Username: username, PasswordHash: passwordHash, CreatedAt: now}, nil
}

// CreateFirstUser inserts the account created by the setup page. It only
// succeeds while the table is empty, so two browsers racing the same setup
// screen cannot both create an account.
func (s *Store) CreateFirstUser(ctx context.Context, username, passwordHash string) (User, error) {
	now := time.Now().UTC()
	res, err := s.db.ExecContext(ctx,
		`INSERT INTO users (username, password_hash, created_at)
		 SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users)`,
		username, passwordHash, unix(now))
	if err != nil {
		return User{}, err
	}
	created, err := res.RowsAffected()
	if err != nil {
		return User{}, err
	}
	if created == 0 {
		return User{}, ErrAlreadyInitialized
	}
	id, err := res.LastInsertId()
	if err != nil {
		return User{}, err
	}
	return User{ID: id, Username: username, PasswordHash: passwordHash, CreatedAt: now}, nil
}

// FindUserByName loads one account.
func (s *Store) FindUserByName(ctx context.Context, username string) (User, error) {
	var u User
	var created int64
	err := s.db.QueryRowContext(ctx,
		`SELECT id, username, password_hash, created_at FROM users WHERE username = ?`, username).
		Scan(&u.ID, &u.Username, &u.PasswordHash, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, ErrNotFound
	}
	if err != nil {
		return User{}, err
	}
	u.CreatedAt = fromUnix(created)
	return u, nil
}

// SetPassword replaces one account's verifier.
func (s *Store) SetPassword(ctx context.Context, userID int64, passwordHash string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE users SET password_hash = ? WHERE id = ?`, passwordHash, userID)
	return err
}

// CreateSession stores a session token hash and returns nothing secret.
func (s *Store) CreateSession(ctx context.Context, userID int64, tokenHash string, expires time.Time, userAgent string) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)`,
		tokenHash, userID, unix(time.Now()), unix(expires), userAgent)
	return err
}

// SessionUser resolves a live session to its user.
func (s *Store) SessionUser(ctx context.Context, tokenHash string) (User, time.Time, error) {
	var u User
	var created, expires int64
	err := s.db.QueryRowContext(ctx,
		`SELECT u.id, u.username, u.password_hash, u.created_at, s.expires_at
		 FROM sessions s JOIN users u ON u.id = s.user_id
		 WHERE s.token_hash = ? AND s.expires_at > ?`,
		tokenHash, unix(time.Now())).Scan(&u.ID, &u.Username, &u.PasswordHash, &created, &expires)
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, time.Time{}, ErrNotFound
	}
	if err != nil {
		return User{}, time.Time{}, err
	}
	u.CreatedAt = fromUnix(created)
	return u, fromUnix(expires), nil
}

// DeleteSession removes one session.
func (s *Store) DeleteSession(ctx context.Context, tokenHash string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE token_hash = ?`, tokenHash)
	return err
}

// PurgeExpiredSessions removes stale rows.
func (s *Store) PurgeExpiredSessions(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE expires_at <= ?`, unix(time.Now()))
	return err
}

const instanceColumns = `id, user_id, instance_key, name, hostname, os, arch, dsh_version, plugin_ver,
	status, connected_at, last_seen, created_at, updated_at`

func scanInstance(row interface{ Scan(...any) error }) (Instance, error) {
	var in Instance
	var connected, lastSeen, created, updated int64
	err := row.Scan(&in.ID, &in.UserID, &in.Key, &in.Name, &in.Hostname, &in.OS, &in.Arch,
		&in.DSHVersion, &in.PluginVer, &in.Status, &connected, &lastSeen, &created, &updated)
	if err != nil {
		return Instance{}, err
	}
	in.ConnectedAt = fromUnix(connected)
	in.LastSeen = fromUnix(lastSeen)
	in.CreatedAt = fromUnix(created)
	in.UpdatedAt = fromUnix(updated)
	return in, nil
}

// UpsertInstance records a plugin connection, reusing the row for the same
// (user, instance_key) pair so the instance keeps its id across reconnects.
func (s *Store) UpsertInstance(ctx context.Context, in Instance) (Instance, error) {
	now := time.Now().UTC()
	existing, err := s.FindInstanceByKey(ctx, in.UserID, in.Key)
	switch {
	case err == nil:
		in.ID = existing.ID
		in.CreatedAt = existing.CreatedAt
		if _, err := s.db.ExecContext(ctx,
			`UPDATE instances SET name = ?, hostname = ?, os = ?, arch = ?, dsh_version = ?, plugin_ver = ?,
			 status = 'online', connected_at = ?, last_seen = ?, updated_at = ? WHERE id = ?`,
			in.Name, in.Hostname, in.OS, in.Arch, in.DSHVersion, in.PluginVer,
			unix(now), unix(now), unix(now), in.ID); err != nil {
			return Instance{}, err
		}
	case errors.Is(err, ErrNotFound):
		if in.ID == "" {
			id, idErr := NewToken(9)
			if idErr != nil {
				return Instance{}, idErr
			}
			in.ID = id
		}
		in.CreatedAt = now
		if _, err := s.db.ExecContext(ctx,
			`INSERT INTO instances (id, user_id, instance_key, name, hostname, os, arch, dsh_version,
			 plugin_ver, status, connected_at, last_seen, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'online', ?, ?, ?, ?)`,
			in.ID, in.UserID, in.Key, in.Name, in.Hostname, in.OS, in.Arch, in.DSHVersion,
			in.PluginVer, unix(now), unix(now), unix(now), unix(now)); err != nil {
			return Instance{}, err
		}
	default:
		return Instance{}, err
	}
	in.Status = "online"
	in.ConnectedAt = now
	in.LastSeen = now
	in.UpdatedAt = now
	return in, nil
}

// FindInstanceByKey loads the row for one plugin identity.
func (s *Store) FindInstanceByKey(ctx context.Context, userID int64, key string) (Instance, error) {
	row := s.db.QueryRowContext(ctx,
		`SELECT `+instanceColumns+` FROM instances WHERE user_id = ? AND instance_key = ?`, userID, key)
	in, err := scanInstance(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Instance{}, ErrNotFound
	}
	return in, err
}

// ListInstances returns every instance of one account, newest activity first.
func (s *Store) ListInstances(ctx context.Context, userID int64) ([]Instance, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT `+instanceColumns+` FROM instances WHERE user_id = ? ORDER BY name COLLATE NOCASE`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Instance, 0, 8)
	for rows.Next() {
		in, err := scanInstance(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, in)
	}
	return out, rows.Err()
}

// GetInstance loads one instance owned by userID.
func (s *Store) GetInstance(ctx context.Context, userID int64, id string) (Instance, error) {
	row := s.db.QueryRowContext(ctx,
		`SELECT `+instanceColumns+` FROM instances WHERE id = ? AND user_id = ?`, id, userID)
	in, err := scanInstance(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Instance{}, ErrNotFound
	}
	return in, err
}

// MarkOffline flips a disconnected instance to offline and stamps last_seen.
func (s *Store) MarkOffline(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE instances SET status = 'offline', last_seen = ?, updated_at = ? WHERE id = ?`,
		unix(time.Now()), unix(time.Now()), id)
	return err
}

// TouchInstance refreshes last_seen for a live tunnel.
func (s *Store) TouchInstance(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE instances SET last_seen = ? WHERE id = ?`, unix(time.Now()), id)
	return err
}

// DeleteInstance removes one instance owned by userID.
func (s *Store) DeleteInstance(ctx context.Context, userID int64, id string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM instances WHERE id = ? AND user_id = ?`, id, userID)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// MarkAllOffline runs at boot: no tunnel can survive a restart.
func (s *Store) MarkAllOffline(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `UPDATE instances SET status = 'offline' WHERE status <> 'offline'`)
	return err
}
