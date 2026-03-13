import { describe, it, expect } from 'vitest'
import { sanitize, shouldSkipAnalysis, calculateCost } from './analyzer.js'

describe('sanitize', () => {
  describe('API keys', () => {
    it('masks OpenAI-style API keys (sk-)', () => {
      const input = 'Using key sk-proj-abc123def456ghi789jkl012mno'
      expect(sanitize(input)).toBe('Using key [REDACTED]')
    })

    it('masks generic api_key assignments', () => {
      const input = 'api_key = "my-secret-api-key-value-here-12345"'
      expect(sanitize(input)).toBe('[REDACTED]')
    })

    it('masks API_KEY in env format', () => {
      const input = 'API_KEY=abcdefghijklmnopqrstuvwxyz123456'
      expect(sanitize(input)).toBe('[REDACTED]')
    })

    it('masks api-secret format', () => {
      const input = 'api-secret: "longSecretValue12345678901234"'
      expect(sanitize(input)).toBe('[REDACTED]')
    })
  })

  describe('GitHub PATs', () => {
    it('masks classic GitHub PAT (ghp_)', () => {
      const input = 'Using ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij for auth'
      expect(sanitize(input)).toBe('Using [REDACTED] for auth')
    })

    it('masks fine-grained GitHub PAT', () => {
      const input = 'github_pat_ABCDEFGHIJKLMNOPQRSTUV_WXYZabcdefghijklmnopqrstuvwxyz0123456789AB'
      expect(sanitize(input)).toBe('[REDACTED]')
    })

    it('masks GitHub secret PAT (ghs_)', () => {
      const input = 'ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij'
      expect(sanitize(input)).toBe('[REDACTED]')
    })
  })

  describe('Bearer tokens', () => {
    it('masks Bearer tokens', () => {
      const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc'
      expect(sanitize(input)).toBe('Authorization: [REDACTED]')
    })
  })

  describe('AWS credentials', () => {
    it('masks AWS access key IDs', () => {
      const input = 'Access key: AKIAIOSFODNN7EXAMPLE'
      expect(sanitize(input)).toBe('Access key: [REDACTED]')
    })

    it('masks AWS secret access keys', () => {
      const input = 'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
      expect(sanitize(input)).toBe('[REDACTED]')
    })
  })

  describe('SSH/TLS private keys', () => {
    it('masks RSA private keys', () => {
      const input = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn
base64encodedkeydata==
-----END RSA PRIVATE KEY-----`
      expect(sanitize(input)).toBe('[REDACTED]')
    })

    it('masks OpenSSH private keys', () => {
      const input = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUA
-----END OPENSSH PRIVATE KEY-----`
      expect(sanitize(input)).toBe('[REDACTED]')
    })
  })

  describe('Database URLs', () => {
    it('masks PostgreSQL connection URLs', () => {
      const input = 'DATABASE_URL=postgresql://user:password123@db.example.com:5432/mydb'
      expect(sanitize(input)).toContain('[REDACTED]')
      expect(sanitize(input)).not.toContain('password123')
    })

    it('masks MongoDB connection URLs', () => {
      const input = 'mongodb+srv://admin:secretpass@cluster0.abc123.mongodb.net/test'
      expect(sanitize(input)).toBe('[REDACTED]')
    })

    it('masks MySQL connection URLs', () => {
      const input = 'mysql://root:mysqlpassword@localhost:3306/app'
      expect(sanitize(input)).toBe('[REDACTED]')
    })

    it('masks Redis connection URLs', () => {
      const input = 'redis://default:redispassword@redis.example.com:6379'
      expect(sanitize(input)).toBe('[REDACTED]')
    })
  })

  describe('Environment variable secrets', () => {
    it('masks PASSWORD assignments', () => {
      const input = 'PASSWORD=my-secret-value'
      expect(sanitize(input)).toBe('[REDACTED]')
    })

    it('masks SECRET assignments', () => {
      const input = 'SECRET: mysecretvalue123'
      expect(sanitize(input)).toBe('[REDACTED]')
    })

    it('masks TOKEN assignments', () => {
      const input = "TOKEN='abc123token'"
      expect(sanitize(input)).toBe('[REDACTED]')
    })
  })

  describe('false positive prevention', () => {
    it('does NOT mask normal code', () => {
      const input = 'const x = 42; function hello() { return "world"; }'
      expect(sanitize(input)).toBe(input)
    })

    it('does NOT mask short identifiers', () => {
      const input = 'const sk = "short"'
      expect(sanitize(input)).toBe(input)
    })

    it('does NOT mask normal URLs without credentials', () => {
      const input = 'https://api.example.com/v1/users'
      expect(sanitize(input)).toBe(input)
    })

    it('does NOT mask variable names containing "key"', () => {
      const input = 'const primaryKey = record.id'
      expect(sanitize(input)).toBe(input)
    })

    it('does NOT mask public SSH keys', () => {
      const input = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ... user@host'
      expect(sanitize(input)).toBe(input)
    })

    it('does NOT mask regular file paths', () => {
      const input = '/usr/local/bin/node /home/user/project/src/index.ts'
      expect(sanitize(input)).toBe(input)
    })

    it('does NOT mask git commands', () => {
      const input = 'git commit -m "fix: resolve issue #123"'
      expect(sanitize(input)).toBe(input)
    })

    it('does NOT mask normal JSON', () => {
      const input = '{"name": "test", "version": "1.0.0", "description": "A test package"}'
      expect(sanitize(input)).toBe(input)
    })
  })

  describe('multiple patterns in one text', () => {
    it('masks all sensitive patterns in a single text', () => {
      const input = `
        API_KEY=sk-proj-my-secret-key-1234567890abcdefgh
        DB: postgresql://user:pass@host/db
        Auth: Bearer abc123token456
      `
      const result = sanitize(input)
      expect(result).not.toContain('sk-proj')
      expect(result).not.toContain('pass@host')
      expect(result).not.toContain('abc123token456')
    })
  })
})

describe('shouldSkipAnalysis', () => {
  it('returns true for logs under 500 characters', () => {
    expect(shouldSkipAnalysis('short log')).toBe(true)
    expect(shouldSkipAnalysis('a'.repeat(499))).toBe(true)
  })

  it('returns false for logs of 500+ characters', () => {
    expect(shouldSkipAnalysis('a'.repeat(500))).toBe(false)
    expect(shouldSkipAnalysis('a'.repeat(1000))).toBe(false)
  })
})

describe('calculateCost', () => {
  it('calculates cost correctly', () => {
    const cost = calculateCost(1000000, 100000)
    // 1M input * $0.80/M + 100K output * $4.00/M = $0.80 + $0.40 = $1.20
    expect(cost).toBeCloseTo(1.20, 2)
  })

  it('returns 0 for zero tokens', () => {
    expect(calculateCost(0, 0)).toBe(0)
  })
})
