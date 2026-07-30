import { describe, it, expect, beforeEach } from '@jest/globals';

type EnvVarType = 'string' | 'url' | 'publicKey' | 'boolean' | 'positiveInt';

interface EnvVarSpec {
  required: boolean;
  type: EnvVarType;
  description: string;
  exampleValue: string;
}

interface EnvVarError {
  key: string;
  value: string | undefined;
  reason: string;
  hint: string;
}

class ConfigurationError extends Error {
  constructor(public errors: EnvVarError[]) {
    super(`Configuration validation failed: ${errors.length} error(s)`);
  }
}

class EnvValidator {
  static validate(schema: Record<string, EnvVarSpec>, env: Record<string, string | undefined>): void {
    const errors: EnvVarError[] = [];

    for (const [key, spec] of Object.entries(schema)) {
      const value = env[key];

      if (value === undefined || value === '') {
        if (spec.required) {
          errors.push({
            key,
            value: undefined,
            reason: 'missing',
            hint: `Set ${key} to ${spec.exampleValue}`,
          });
        }
        continue;
      }

      const error = this.validateType(key, value, spec);
      if (error) {
        errors.push(error);
      }
    }

    if (errors.length > 0) {
      throw new ConfigurationError(errors);
    }
  }

  private static validateType(key: string, value: string, spec: EnvVarSpec): EnvVarError | null {
    switch (spec.type) {
      case 'string':
        return null;

      case 'url':
        try {
          new URL(value);
          return null;
        } catch {
          return {
            key,
            value: value.substring(0, 50),
            reason: 'invalid_url',
            hint: `Set ${key} to a valid URL, e.g., ${spec.exampleValue}`,
          };
        }

      case 'publicKey':
        if (this.isValidPublicKey(value)) {
          return null;
        }
        return {
          key,
          value: `${value.substring(0, 6)}...`,
          reason: 'invalid_publicKey',
          hint: `Set ${key} to a valid Stellar public key, e.g., ${spec.exampleValue}`,
        };

      case 'boolean':
        if (value === 'true' || value === 'false') {
          return null;
        }
        return {
          key,
          value,
          reason: 'invalid_boolean',
          hint: `Set ${key} to either 'true' or 'false'`,
        };

      case 'positiveInt':
        try {
          const num = parseInt(value, 10);
          if (!isNaN(num) && num > 0) {
            return null;
          }
        } catch {
          // fall through
        }
        return {
          key,
          value,
          reason: 'invalid_positiveInt',
          hint: `Set ${key} to a positive integer, e.g., ${spec.exampleValue}`,
        };

      default:
        return null;
    }
  }

  private static isValidPublicKey(value: string): boolean {
    // Simplified validation - real implementation uses Keypair.fromPublicKey()
    return /^G[A-Z2-7]{55}$/.test(value);
  }
}

describe('EnvValidator', () => {
  const baseSchema: Record<string, EnvVarSpec> = {
    STELLAR_RPC_URL: {
      required: true,
      type: 'url',
      description: 'Stellar RPC endpoint',
      exampleValue: 'https://soroban-testnet.stellar.org',
    },
    STELLAR_NETWORK: {
      required: true,
      type: 'string',
      description: 'Stellar network (testnet, mainnet)',
      exampleValue: 'testnet',
    },
    SPLIT_CONTRACT_ID: {
      required: true,
      type: 'publicKey',
      description: 'Split contract public key',
      exampleValue: 'GBJCHUKKMPLFSLOMNC34P6IGGBWKYX5XU5LJXN62A3VCDSXFYJZ4E7E',
    },
    OPTIONAL_SETTING: {
      required: false,
      type: 'string',
      description: 'Optional setting',
      exampleValue: 'default-value',
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should pass when all required variables are valid', () => {
    const env = {
      STELLAR_RPC_URL: 'https://soroban-testnet.stellar.org',
      STELLAR_NETWORK: 'testnet',
      SPLIT_CONTRACT_ID: 'GBJCHUKKMPLFSLOMNC34P6IGGBWKYX5XU5LJXN62A3VCDSXFYJZ4E7E',
    };

    expect(() => EnvValidator.validate(baseSchema, env)).not.toThrow();
  });

  it('should throw ConfigurationError with error for missing required variable', () => {
    const env = {
      STELLAR_NETWORK: 'testnet',
      SPLIT_CONTRACT_ID: 'GBJCHUKKMPLFSLOMNC34P6IGGBWKYX5XU5LJXN62A3VCDSXFYJZ4E7E',
    };

    try {
      EnvValidator.validate(baseSchema, env);
      fail('Should have thrown ConfigurationError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      const configError = error as ConfigurationError;
      expect(configError.errors).toHaveLength(1);
      expect(configError.errors[0]).toEqual({
        key: 'STELLAR_RPC_URL',
        value: undefined,
        reason: 'missing',
        hint: expect.stringContaining('STELLAR_RPC_URL'),
      });
    }
  });

  it('should collect all errors before throwing', () => {
    const env = {
      STELLAR_NETWORK: 'testnet',
    };

    try {
      EnvValidator.validate(baseSchema, env);
      fail('Should have thrown ConfigurationError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      const configError = error as ConfigurationError;
      expect(configError.errors.length).toBeGreaterThanOrEqual(2);
      expect(configError.errors.map((e) => e.key)).toContain('STELLAR_RPC_URL');
      expect(configError.errors.map((e) => e.key)).toContain('SPLIT_CONTRACT_ID');
    }
  });

  it('should validate URL type and reject invalid URLs', () => {
    const env = {
      STELLAR_RPC_URL: 'not-a-url',
      STELLAR_NETWORK: 'testnet',
      SPLIT_CONTRACT_ID: 'GBJCHUKKMPLFSLOMNC34P6IGGBWKYX5XU5LJXN62A3VCDSXFYJZ4E7E',
    };

    try {
      EnvValidator.validate(baseSchema, env);
      fail('Should have thrown ConfigurationError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      const configError = error as ConfigurationError;
      const urlError = configError.errors.find((e) => e.key === 'STELLAR_RPC_URL');
      expect(urlError).toBeDefined();
      expect(urlError?.reason).toBe('invalid_url');
    }
  });

  it('should validate public key type and reject invalid keys', () => {
    const env = {
      STELLAR_RPC_URL: 'https://soroban-testnet.stellar.org',
      STELLAR_NETWORK: 'testnet',
      SPLIT_CONTRACT_ID: 'not-a-public-key',
    };

    try {
      EnvValidator.validate(baseSchema, env);
      fail('Should have thrown ConfigurationError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      const configError = error as ConfigurationError;
      const keyError = configError.errors.find((e) => e.key === 'SPLIT_CONTRACT_ID');
      expect(keyError).toBeDefined();
      expect(keyError?.reason).toBe('invalid_publicKey');
    }
  });

  it('should redact public key values in error output', () => {
    const env = {
      STELLAR_RPC_URL: 'https://soroban-testnet.stellar.org',
      STELLAR_NETWORK: 'testnet',
      SPLIT_CONTRACT_ID: 'GBJCHUKKMPLFSLOMNC34P6IGGBWKYX5XU5LJXN62A3VCDSXFYJZ4E7E_INVALID',
    };

    try {
      EnvValidator.validate(baseSchema, env);
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      const configError = error as ConfigurationError;
      const keyError = configError.errors.find((e) => e.key === 'SPLIT_CONTRACT_ID');
      expect(keyError?.value).not.toContain('VCDSXFYJZ4E7E');
      expect(keyError?.value).toMatch(/^G/);
    }
  });

  it('should allow optional variables to be missing', () => {
    const env = {
      STELLAR_RPC_URL: 'https://soroban-testnet.stellar.org',
      STELLAR_NETWORK: 'testnet',
      SPLIT_CONTRACT_ID: 'GBJCHUKKMPLFSLOMNC34P6IGGBWKYX5XU5LJXN62A3VCDSXFYJZ4E7E',
      // OPTIONAL_SETTING is not provided
    };

    expect(() => EnvValidator.validate(baseSchema, env)).not.toThrow();
  });

  it('should validate boolean type', () => {
    const boolSchema: Record<string, EnvVarSpec> = {
      ENABLE_FEATURE: {
        required: true,
        type: 'boolean',
        description: 'Enable feature',
        exampleValue: 'true',
      },
    };

    expect(() => EnvValidator.validate(boolSchema, { ENABLE_FEATURE: 'true' })).not.toThrow();
    expect(() => EnvValidator.validate(boolSchema, { ENABLE_FEATURE: 'false' })).not.toThrow();

    try {
      EnvValidator.validate(boolSchema, { ENABLE_FEATURE: 'yes' });
      fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      const configError = error as ConfigurationError;
      expect(configError.errors[0].reason).toBe('invalid_boolean');
    }
  });

  it('should validate positiveInt type', () => {
    const intSchema: Record<string, EnvVarSpec> = {
      MAX_RETRIES: {
        required: true,
        type: 'positiveInt',
        description: 'Max retries',
        exampleValue: '5',
      },
    };

    expect(() => EnvValidator.validate(intSchema, { MAX_RETRIES: '5' })).not.toThrow();
    expect(() => EnvValidator.validate(intSchema, { MAX_RETRIES: '1' })).not.toThrow();

    try {
      EnvValidator.validate(intSchema, { MAX_RETRIES: '0' });
      fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      const configError = error as ConfigurationError;
      expect(configError.errors[0].reason).toBe('invalid_positiveInt');
    }

    try {
      EnvValidator.validate(intSchema, { MAX_RETRIES: '-5' });
      fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      const configError = error as ConfigurationError;
      expect(configError.errors[0].reason).toBe('invalid_positiveInt');
    }
  });

  it('should provide helpful remediation hints for errors', () => {
    const env = {
      STELLAR_NETWORK: 'testnet',
    };

    try {
      EnvValidator.validate(baseSchema, env);
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      const configError = error as ConfigurationError;
      for (const err of configError.errors) {
        expect(err.hint).toBeTruthy();
        expect(err.hint.length).toBeGreaterThan(0);
      }
    }
  });
});
