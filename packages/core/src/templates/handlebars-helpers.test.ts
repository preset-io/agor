import Handlebars from 'handlebars';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildWorktreeContext,
  registerHandlebarsHelpers,
  renderTemplate,
} from './handlebars-helpers';

describe('handlebars-helpers', () => {
  let consoleWarnSpy: any;
  let consoleErrorSpy: any;

  beforeEach(() => {
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Register helpers once - they persist across tests
    // Note: We don't reset helpers between tests to avoid issues with Handlebars internal state
    registerHandlebarsHelpers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ===== Arithmetic Helpers =====

  describe('add helper', () => {
    it('should add two positive numbers', () => {
      const template = Handlebars.compile('{{add 5 3}}');
      expect(template({})).toBe('8');
    });

    it('should add negative numbers', () => {
      const template = Handlebars.compile('{{add -5 3}}');
      expect(template({})).toBe('-2');
    });

    it('should add with zero', () => {
      const template = Handlebars.compile('{{add 10 0}}');
      expect(template({})).toBe('10');
    });

    it('should add floating point numbers', () => {
      const template = Handlebars.compile('{{add 5.5 2.3}}');
      expect(template({})).toBe('7.8');
    });

    it('should add variables from context', () => {
      const template = Handlebars.compile('{{add PORT_SEED 6000}}');
      expect(template({ PORT_SEED: 42 })).toBe('6042');
    });

    it('should handle string numbers', () => {
      const template = Handlebars.compile('{{add a b}}');
      expect(template({ a: '10', b: '5' })).toBe('15');
    });

    it('should warn and return 0 for non-numeric first argument', () => {
      const template = Handlebars.compile('{{add a b}}');
      expect(template({ a: 'foo', b: 5 })).toBe('0');
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('add helper received non-numeric values: foo, 5')
      );
    });

    it('should warn and return 0 for non-numeric second argument', () => {
      const template = Handlebars.compile('{{add a b}}');
      expect(template({ a: 5, b: 'bar' })).toBe('0');
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('add helper received non-numeric values: 5, bar')
      );
    });

    it('should warn and return 0 for both non-numeric arguments', () => {
      const template = Handlebars.compile('{{add a b}}');
      expect(template({ a: 'foo', b: 'bar' })).toBe('0');
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('add helper received non-numeric values: foo, bar')
      );
    });

    it('should handle undefined values', () => {
      const template = Handlebars.compile('{{add a b}}');
      expect(template({})).toBe('0');
      expect(consoleWarnSpy).toHaveBeenCalled();
    });

    it('should handle null values', () => {
      const template = Handlebars.compile('{{add a b}}');
      expect(template({ a: null, b: null })).toBe('0');
    });

    it('should handle very large numbers', () => {
      const template = Handlebars.compile('{{add a b}}');
      expect(template({ a: 1e15, b: 1e15 })).toBe('2000000000000000');
    });
  });

  describe('sub helper', () => {
    it('should subtract two positive numbers', () => {
      const template = Handlebars.compile('{{sub 10 3}}');
      expect(template({})).toBe('7');
    });

    it('should subtract negative numbers', () => {
      const template = Handlebars.compile('{{sub 5 -3}}');
      expect(template({})).toBe('8');
    });

    it('should subtract resulting in negative', () => {
      const template = Handlebars.compile('{{sub 3 10}}');
      expect(template({})).toBe('-7');
    });

    it('should subtract with zero', () => {
      const template = Handlebars.compile('{{sub 10 0}}');
      expect(template({})).toBe('10');
    });

    it('should subtract floating point numbers', () => {
      const template = Handlebars.compile('{{sub 10.5 3.2}}');
      expect(template({})).toBe('7.3');
    });

    it('should subtract variables from context', () => {
      const template = Handlebars.compile('{{sub BASE PORT_SEED}}');
      expect(template({ BASE: 8000, PORT_SEED: 42 })).toBe('7958');
    });

    it('should warn and return 0 for non-numeric values', () => {
      const template = Handlebars.compile('{{sub a b}}');
      expect(template({ a: 'foo', b: 5 })).toBe('0');
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('sub helper received non-numeric values: foo, 5')
      );
    });

    it('should handle undefined values', () => {
      const template = Handlebars.compile('{{sub a b}}');
      expect(template({})).toBe('0');
      expect(consoleWarnSpy).toHaveBeenCalled();
    });

    it('should subtract zero from zero', () => {
      const template = Handlebars.compile('{{sub 0 0}}');
      expect(template({})).toBe('0');
    });
  });

  describe('mul helper', () => {
    it('should multiply two positive numbers', () => {
      const template = Handlebars.compile('{{mul 5 3}}');
      expect(template({})).toBe('15');
    });

    it('should multiply negative numbers', () => {
      const template = Handlebars.compile('{{mul -5 3}}');
      expect(template({})).toBe('-15');
    });

    it('should multiply by zero', () => {
      const template = Handlebars.compile('{{mul 10 0}}');
      expect(template({})).toBe('0');
    });

    it('should multiply by one', () => {
      const template = Handlebars.compile('{{mul 10 1}}');
      expect(template({})).toBe('10');
    });

    it('should multiply floating point numbers', () => {
      const template = Handlebars.compile('{{mul 2.5 4}}');
      expect(template({})).toBe('10');
    });

    it('should multiply variables from context', () => {
      const template = Handlebars.compile('{{mul PORT_SEED 10}}');
      expect(template({ PORT_SEED: 42 })).toBe('420');
    });

    it('should warn and return 0 for non-numeric values', () => {
      const template = Handlebars.compile('{{mul a b}}');
      expect(template({ a: 'foo', b: 5 })).toBe('0');
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('mul helper received non-numeric values: foo, 5')
      );
    });

    it('should handle undefined values', () => {
      const template = Handlebars.compile('{{mul a b}}');
      expect(template({})).toBe('0');
      expect(consoleWarnSpy).toHaveBeenCalled();
    });

    it('should multiply very large numbers', () => {
      const template = Handlebars.compile('{{mul a b}}');
      expect(template({ a: 1000, b: 1000 })).toBe('1000000');
    });

    it('should handle multiplication with negative zero', () => {
      const template = Handlebars.compile('{{mul -5 0}}');
      // JavaScript converts -0 to 0 when stringified
      expect(template({})).toBe('0');
    });
  });

  describe('div helper', () => {
    it('should divide two positive numbers', () => {
      const template = Handlebars.compile('{{div 10 2}}');
      expect(template({})).toBe('5');
    });

    it('should divide with remainder', () => {
      const template = Handlebars.compile('{{div 10 3}}');
      expect(template({})).toBe('3.3333333333333335');
    });

    it('should divide negative numbers', () => {
      const template = Handlebars.compile('{{div -10 2}}');
      expect(template({})).toBe('-5');
    });

    it('should divide by one', () => {
      const template = Handlebars.compile('{{div 10 1}}');
      expect(template({})).toBe('10');
    });

    it('should divide floating point numbers', () => {
      const template = Handlebars.compile('{{div 10.5 2.5}}');
      expect(template({})).toBe('4.2');
    });

    it('should divide variables from context', () => {
      const template = Handlebars.compile('{{div PORT_SEED 2}}');
      expect(template({ PORT_SEED: 100 })).toBe('50');
    });

    it('should warn and return 0 for division by zero', () => {
      const template = Handlebars.compile('{{div 10 0}}');
      expect(template({})).toBe('0');
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('div helper received zero divisor')
      );
    });

    it('should warn and return 0 for non-numeric values', () => {
      const template = Handlebars.compile('{{div a b}}');
      expect(template({ a: 'foo', b: 5 })).toBe('0');
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('div helper received non-numeric values: foo, 5')
      );
    });

    it('should handle undefined values', () => {
      const template = Handlebars.compile('{{div a b}}');
      expect(template({})).toBe('0');
      expect(consoleWarnSpy).toHaveBeenCalled();
    });

    it('should divide zero by number', () => {
      const template = Handlebars.compile('{{div 0 5}}');
      expect(template({})).toBe('0');
    });

    it('should handle division resulting in infinity', () => {
      const template = Handlebars.compile('{{div 1 0}}');
      expect(template({})).toBe('0');
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('div helper received zero divisor')
      );
    });
  });

  describe('mod helper', () => {
    it('should calculate modulo of two positive numbers', () => {
      const template = Handlebars.compile('{{mod 10 3}}');
      expect(template({})).toBe('1');
    });

    it('should calculate modulo with zero remainder', () => {
      const template = Handlebars.compile('{{mod 10 5}}');
      expect(template({})).toBe('0');
    });

    it('should calculate modulo with negative numbers', () => {
      const template = Handlebars.compile('{{mod -10 3}}');
      expect(template({})).toBe('-1');
    });

    it('should calculate modulo with one', () => {
      const template = Handlebars.compile('{{mod 10 1}}');
      expect(template({})).toBe('0');
    });

    it('should calculate modulo with floating point numbers', () => {
      const template = Handlebars.compile('{{mod 10.5 3}}');
      expect(template({})).toBe('1.5');
    });

    it('should calculate modulo with variables from context', () => {
      const template = Handlebars.compile('{{mod PORT_SEED 100}}');
      expect(template({ PORT_SEED: 442 })).toBe('42');
    });

    it('should warn and return 0 for modulo by zero', () => {
      const template = Handlebars.compile('{{mod 10 0}}');
      expect(template({})).toBe('0');
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('mod helper received zero divisor')
      );
    });

    it('should warn and return 0 for non-numeric values', () => {
      const template = Handlebars.compile('{{mod a b}}');
      expect(template({ a: 'foo', b: 5 })).toBe('0');
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('mod helper received non-numeric values: foo, 5')
      );
    });

    it('should handle undefined values', () => {
      const template = Handlebars.compile('{{mod a b}}');
      expect(template({})).toBe('0');
      expect(consoleWarnSpy).toHaveBeenCalled();
    });

    it('should calculate modulo when dividend is smaller', () => {
      const template = Handlebars.compile('{{mod 3 10}}');
      expect(template({})).toBe('3');
    });

    it('should handle modulo with zero dividend', () => {
      const template = Handlebars.compile('{{mod 0 5}}');
      expect(template({})).toBe('0');
    });
  });

  // ===== String Helpers =====

  describe('uppercase helper', () => {
    it('should convert lowercase string to uppercase', () => {
      const template = Handlebars.compile('{{uppercase name}}');
      expect(template({ name: 'hello' })).toBe('HELLO');
    });

    it('should handle mixed case strings', () => {
      const template = Handlebars.compile('{{uppercase name}}');
      expect(template({ name: 'HeLLo WoRLd' })).toBe('HELLO WORLD');
    });

    it('should handle already uppercase strings', () => {
      const template = Handlebars.compile('{{uppercase name}}');
      expect(template({ name: 'HELLO' })).toBe('HELLO');
    });

    it('should handle empty strings', () => {
      const template = Handlebars.compile('{{uppercase name}}');
      expect(template({ name: '' })).toBe('');
    });

    it('should handle undefined values', () => {
      const template = Handlebars.compile('{{uppercase name}}');
      expect(template({})).toBe('');
    });

    it('should handle null values', () => {
      const template = Handlebars.compile('{{uppercase name}}');
      expect(template({ name: null })).toBe('');
    });

    it('should handle numbers as strings', () => {
      const template = Handlebars.compile('{{uppercase name}}');
      expect(template({ name: 123 })).toBe('123');
    });

    it('should handle strings with special characters', () => {
      const template = Handlebars.compile('{{uppercase name}}');
      expect(template({ name: 'hello-world_123' })).toBe('HELLO-WORLD_123');
    });

    it('should handle unicode characters', () => {
      const template = Handlebars.compile('{{uppercase name}}');
      expect(template({ name: 'café' })).toBe('CAFÉ');
    });

    it('should handle strings with spaces', () => {
      const template = Handlebars.compile('{{uppercase name}}');
      expect(template({ name: 'hello world' })).toBe('HELLO WORLD');
    });
  });

  describe('lowercase helper', () => {
    it('should convert uppercase string to lowercase', () => {
      const template = Handlebars.compile('{{lowercase name}}');
      expect(template({ name: 'HELLO' })).toBe('hello');
    });

    it('should handle mixed case strings', () => {
      const template = Handlebars.compile('{{lowercase name}}');
      expect(template({ name: 'HeLLo WoRLd' })).toBe('hello world');
    });

    it('should handle already lowercase strings', () => {
      const template = Handlebars.compile('{{lowercase name}}');
      expect(template({ name: 'hello' })).toBe('hello');
    });

    it('should handle empty strings', () => {
      const template = Handlebars.compile('{{lowercase name}}');
      expect(template({ name: '' })).toBe('');
    });

    it('should handle undefined values', () => {
      const template = Handlebars.compile('{{lowercase name}}');
      expect(template({})).toBe('');
    });

    it('should handle null values', () => {
      const template = Handlebars.compile('{{lowercase name}}');
      expect(template({ name: null })).toBe('');
    });

    it('should handle numbers as strings', () => {
      const template = Handlebars.compile('{{lowercase name}}');
      expect(template({ name: 123 })).toBe('123');
    });

    it('should handle strings with special characters', () => {
      const template = Handlebars.compile('{{lowercase name}}');
      expect(template({ name: 'HELLO-WORLD_123' })).toBe('hello-world_123');
    });

    it('should handle unicode characters', () => {
      const template = Handlebars.compile('{{lowercase name}}');
      expect(template({ name: 'CAFÉ' })).toBe('café');
    });

    it('should handle strings with spaces', () => {
      const template = Handlebars.compile('{{lowercase name}}');
      expect(template({ name: 'HELLO WORLD' })).toBe('hello world');
    });
  });

  describe('replace helper', () => {
    it('should replace single occurrence', () => {
      const template = Handlebars.compile('{{replace name "-" "_"}}');
      expect(template({ name: 'hello-world' })).toBe('hello_world');
    });

    it('should replace multiple occurrences', () => {
      const template = Handlebars.compile('{{replace name "-" "_"}}');
      expect(template({ name: 'hello-world-foo-bar' })).toBe('hello_world_foo_bar');
    });

    it('should replace with empty string', () => {
      const template = Handlebars.compile('{{replace name "-" ""}}');
      expect(template({ name: 'hello-world' })).toBe('helloworld');
    });

    it('should handle no matches', () => {
      const template = Handlebars.compile('{{replace name "-" "_"}}');
      expect(template({ name: 'helloworld' })).toBe('helloworld');
    });

    it('should handle empty input string', () => {
      const template = Handlebars.compile('{{replace name "-" "_"}}');
      expect(template({ name: '' })).toBe('');
    });

    it('should handle undefined values', () => {
      const template = Handlebars.compile('{{replace name "-" "_"}}');
      expect(template({})).toBe('');
    });

    it('should handle null values', () => {
      const template = Handlebars.compile('{{replace name "-" "_"}}');
      expect(template({ name: null })).toBe('');
    });

    it('should replace special characters', () => {
      const template = Handlebars.compile('{{replace name "." "-"}}');
      expect(template({ name: 'hello.world.foo' })).toBe('hello-world-foo');
    });

    it('should handle whitespace replacement', () => {
      const template = Handlebars.compile('{{replace name " " "-"}}');
      expect(template({ name: 'hello world foo' })).toBe('hello-world-foo');
    });

    it('should handle multi-character search strings', () => {
      const template = Handlebars.compile('{{replace name "foo" "bar"}}');
      expect(template({ name: 'hello foo world foo' })).toBe('hello bar world bar');
    });

    it('should handle multi-character replacement strings', () => {
      const template = Handlebars.compile('{{replace name "-" "___"}}');
      expect(template({ name: 'hello-world' })).toBe('hello___world');
    });

    it('should handle numbers as strings', () => {
      const template = Handlebars.compile('{{replace name "1" "X"}}');
      expect(template({ name: '12131' })).toBe('X2X3X');
    });
  });

  // ===== Conditional Helpers =====

  describe('eq helper', () => {
    it('should return true for equal strings', () => {
      const template = Handlebars.compile('{{eq status "running"}}');
      expect(template({ status: 'running' })).toBe('true');
    });

    it('should return false for unequal strings', () => {
      const template = Handlebars.compile('{{eq status "running"}}');
      expect(template({ status: 'stopped' })).toBe('false');
    });

    it('should return true for equal numbers', () => {
      const template = Handlebars.compile('{{eq count 5}}');
      expect(template({ count: 5 })).toBe('true');
    });

    it('should return false for unequal numbers', () => {
      const template = Handlebars.compile('{{eq count 5}}');
      expect(template({ count: 10 })).toBe('false');
    });

    it('should handle strict equality with type differences', () => {
      const template = Handlebars.compile('{{eq count "5"}}');
      expect(template({ count: 5 })).toBe('false');
    });

    it('should return true for both undefined', () => {
      const template = Handlebars.compile('{{eq a b}}');
      expect(template({})).toBe('true');
    });

    it('should return true for both null', () => {
      const template = Handlebars.compile('{{eq a b}}');
      expect(template({ a: null, b: null })).toBe('true');
    });

    it('should return false for undefined vs null', () => {
      const template = Handlebars.compile('{{eq a b}}');
      expect(template({ a: undefined, b: null })).toBe('false');
    });

    it('should return true for equal booleans', () => {
      const template = Handlebars.compile('{{eq a b}}');
      expect(template({ a: true, b: true })).toBe('true');
    });

    it('should return false for unequal booleans', () => {
      const template = Handlebars.compile('{{eq a b}}');
      expect(template({ a: true, b: false })).toBe('false');
    });

    it('should handle empty strings', () => {
      const template = Handlebars.compile('{{eq a ""}}');
      expect(template({ a: '' })).toBe('true');
    });

    it('should handle zero comparison', () => {
      const template = Handlebars.compile('{{eq a 0}}');
      expect(template({ a: 0 })).toBe('true');
    });

    it('should work in if blocks', () => {
      const template = Handlebars.compile('{{#if (eq status "running")}}yes{{else}}no{{/if}}');
      expect(template({ status: 'running' })).toBe('yes');
      expect(template({ status: 'stopped' })).toBe('no');
    });
  });

  describe('neq helper', () => {
    it('should return false for equal strings', () => {
      const template = Handlebars.compile('{{neq status "running"}}');
      expect(template({ status: 'running' })).toBe('false');
    });

    it('should return true for unequal strings', () => {
      const template = Handlebars.compile('{{neq status "running"}}');
      expect(template({ status: 'stopped' })).toBe('true');
    });

    it('should return false for equal numbers', () => {
      const template = Handlebars.compile('{{neq count 5}}');
      expect(template({ count: 5 })).toBe('false');
    });

    it('should return true for unequal numbers', () => {
      const template = Handlebars.compile('{{neq count 5}}');
      expect(template({ count: 10 })).toBe('true');
    });

    it('should handle strict inequality with type differences', () => {
      const template = Handlebars.compile('{{neq count "5"}}');
      expect(template({ count: 5 })).toBe('true');
    });

    it('should return false for both undefined', () => {
      const template = Handlebars.compile('{{neq a b}}');
      expect(template({})).toBe('false');
    });

    it('should return true for undefined vs null', () => {
      const template = Handlebars.compile('{{neq a b}}');
      expect(template({ a: undefined, b: null })).toBe('true');
    });

    it('should return false for equal booleans', () => {
      const template = Handlebars.compile('{{neq a b}}');
      expect(template({ a: true, b: true })).toBe('false');
    });

    it('should return true for unequal booleans', () => {
      const template = Handlebars.compile('{{neq a b}}');
      expect(template({ a: true, b: false })).toBe('true');
    });

    it('should work in if blocks', () => {
      const template = Handlebars.compile('{{#if (neq status "running")}}yes{{else}}no{{/if}}');
      expect(template({ status: 'running' })).toBe('no');
      expect(template({ status: 'stopped' })).toBe('yes');
    });
  });

  describe('gt helper', () => {
    it('should return true when first is greater', () => {
      const template = Handlebars.compile('{{gt a b}}');
      expect(template({ a: 10, b: 5 })).toBe('true');
    });

    it('should return false when first is less', () => {
      const template = Handlebars.compile('{{gt a b}}');
      expect(template({ a: 5, b: 10 })).toBe('false');
    });

    it('should return false when equal', () => {
      const template = Handlebars.compile('{{gt a b}}');
      expect(template({ a: 5, b: 5 })).toBe('false');
    });

    it('should handle negative numbers', () => {
      const template = Handlebars.compile('{{gt a b}}');
      expect(template({ a: -5, b: -10 })).toBe('true');
    });

    it('should handle floating point numbers', () => {
      const template = Handlebars.compile('{{gt a b}}');
      expect(template({ a: 5.5, b: 5.4 })).toBe('true');
    });

    it('should handle string numbers', () => {
      const template = Handlebars.compile('{{gt a b}}');
      expect(template({ a: '10', b: '5' })).toBe('true');
    });

    it('should handle zero comparison', () => {
      const template = Handlebars.compile('{{gt a 0}}');
      expect(template({ a: 1 })).toBe('true');
    });

    it('should return false for NaN comparisons', () => {
      const template = Handlebars.compile('{{gt a b}}');
      expect(template({ a: 'foo', b: 5 })).toBe('false');
    });

    it('should work in if blocks', () => {
      const template = Handlebars.compile('{{#if (gt a b)}}yes{{else}}no{{/if}}');
      expect(template({ a: 10, b: 5 })).toBe('yes');
      expect(template({ a: 5, b: 10 })).toBe('no');
    });
  });

  describe('lt helper', () => {
    it('should return true when first is less', () => {
      const template = Handlebars.compile('{{lt a b}}');
      expect(template({ a: 5, b: 10 })).toBe('true');
    });

    it('should return false when first is greater', () => {
      const template = Handlebars.compile('{{lt a b}}');
      expect(template({ a: 10, b: 5 })).toBe('false');
    });

    it('should return false when equal', () => {
      const template = Handlebars.compile('{{lt a b}}');
      expect(template({ a: 5, b: 5 })).toBe('false');
    });

    it('should handle negative numbers', () => {
      const template = Handlebars.compile('{{lt a b}}');
      expect(template({ a: -10, b: -5 })).toBe('true');
    });

    it('should handle floating point numbers', () => {
      const template = Handlebars.compile('{{lt a b}}');
      expect(template({ a: 5.4, b: 5.5 })).toBe('true');
    });

    it('should handle string numbers', () => {
      const template = Handlebars.compile('{{lt a b}}');
      expect(template({ a: '5', b: '10' })).toBe('true');
    });

    it('should handle zero comparison', () => {
      const template = Handlebars.compile('{{lt a 0}}');
      expect(template({ a: -1 })).toBe('true');
    });

    it('should return false for NaN comparisons', () => {
      const template = Handlebars.compile('{{lt a b}}');
      expect(template({ a: 'foo', b: 5 })).toBe('false');
    });

    it('should work in if blocks', () => {
      const template = Handlebars.compile('{{#if (lt a b)}}yes{{else}}no{{/if}}');
      expect(template({ a: 5, b: 10 })).toBe('yes');
      expect(template({ a: 10, b: 5 })).toBe('no');
    });
  });

  describe('gte helper', () => {
    it('should return true when first is greater', () => {
      const template = Handlebars.compile('{{gte a b}}');
      expect(template({ a: 10, b: 5 })).toBe('true');
    });

    it('should return false when first is less', () => {
      const template = Handlebars.compile('{{gte a b}}');
      expect(template({ a: 5, b: 10 })).toBe('false');
    });

    it('should return true when equal', () => {
      const template = Handlebars.compile('{{gte a b}}');
      expect(template({ a: 5, b: 5 })).toBe('true');
    });

    it('should handle negative numbers', () => {
      const template = Handlebars.compile('{{gte a b}}');
      expect(template({ a: -5, b: -10 })).toBe('true');
    });

    it('should handle floating point numbers', () => {
      const template = Handlebars.compile('{{gte a b}}');
      expect(template({ a: 5.5, b: 5.5 })).toBe('true');
    });

    it('should handle string numbers', () => {
      const template = Handlebars.compile('{{gte a b}}');
      expect(template({ a: '10', b: '5' })).toBe('true');
    });

    it('should handle zero comparison', () => {
      const template = Handlebars.compile('{{gte a 0}}');
      expect(template({ a: 0 })).toBe('true');
    });

    it('should return false for NaN comparisons', () => {
      const template = Handlebars.compile('{{gte a b}}');
      expect(template({ a: 'foo', b: 5 })).toBe('false');
    });

    it('should work in if blocks', () => {
      const template = Handlebars.compile('{{#if (gte a b)}}yes{{else}}no{{/if}}');
      expect(template({ a: 10, b: 5 })).toBe('yes');
      expect(template({ a: 5, b: 5 })).toBe('yes');
      expect(template({ a: 5, b: 10 })).toBe('no');
    });
  });

  describe('lte helper', () => {
    it('should return true when first is less', () => {
      const template = Handlebars.compile('{{lte a b}}');
      expect(template({ a: 5, b: 10 })).toBe('true');
    });

    it('should return false when first is greater', () => {
      const template = Handlebars.compile('{{lte a b}}');
      expect(template({ a: 10, b: 5 })).toBe('false');
    });

    it('should return true when equal', () => {
      const template = Handlebars.compile('{{lte a b}}');
      expect(template({ a: 5, b: 5 })).toBe('true');
    });

    it('should handle negative numbers', () => {
      const template = Handlebars.compile('{{lte a b}}');
      expect(template({ a: -10, b: -5 })).toBe('true');
    });

    it('should handle floating point numbers', () => {
      const template = Handlebars.compile('{{lte a b}}');
      expect(template({ a: 5.5, b: 5.5 })).toBe('true');
    });

    it('should handle string numbers', () => {
      const template = Handlebars.compile('{{lte a b}}');
      expect(template({ a: '5', b: '10' })).toBe('true');
    });

    it('should handle zero comparison', () => {
      const template = Handlebars.compile('{{lte a 0}}');
      expect(template({ a: 0 })).toBe('true');
    });

    it('should return false for NaN comparisons', () => {
      const template = Handlebars.compile('{{lte a b}}');
      expect(template({ a: 'foo', b: 5 })).toBe('false');
    });

    it('should work in if blocks', () => {
      const template = Handlebars.compile('{{#if (lte a b)}}yes{{else}}no{{/if}}');
      expect(template({ a: 5, b: 10 })).toBe('yes');
      expect(template({ a: 5, b: 5 })).toBe('yes');
      expect(template({ a: 10, b: 5 })).toBe('no');
    });
  });

  // ===== Utility Helpers =====

  describe('default helper', () => {
    it('should return value when defined', () => {
      const template = Handlebars.compile('{{default name "Anonymous"}}');
      expect(template({ name: 'John' })).toBe('John');
    });

    it('should return default when value is undefined', () => {
      const template = Handlebars.compile('{{default name "Anonymous"}}');
      expect(template({})).toBe('Anonymous');
    });

    it('should return default when value is null', () => {
      const template = Handlebars.compile('{{default name "Anonymous"}}');
      expect(template({ name: null })).toBe('Anonymous');
    });

    it('should return value when it is zero', () => {
      const template = Handlebars.compile('{{default count 10}}');
      expect(template({ count: 0 })).toBe('0');
    });

    it('should return value when it is false', () => {
      const template = Handlebars.compile('{{default flag true}}');
      expect(template({ flag: false })).toBe('false');
    });

    it('should return value when it is empty string', () => {
      const template = Handlebars.compile('{{default name "Default"}}');
      expect(template({ name: '' })).toBe('');
    });

    it('should handle numeric defaults', () => {
      const template = Handlebars.compile('{{default PORT_SEED 100}}');
      expect(template({})).toBe('100');
    });

    it('should handle boolean defaults', () => {
      const template = Handlebars.compile('{{default enabled true}}');
      expect(template({})).toBe('true');
    });

    it('should handle object defaults', () => {
      const template = Handlebars.compile('{{json (default config defaultConfig)}}');
      const defaultConfig = { port: 3000 };
      const result = template({ defaultConfig });
      expect(result).toContain('3000');
    });

    it('should handle both values being undefined', () => {
      const template = Handlebars.compile('{{default a b}}');
      expect(template({})).toBe('');
    });
  });

  describe('json helper', () => {
    it('should stringify simple object', () => {
      const template = Handlebars.compile('{{json obj}}');
      const result = template({ obj: { name: 'John', age: 30 } });
      expect(result).toContain('John');
      expect(result).toContain('30');
    });

    it('should stringify nested object', () => {
      const template = Handlebars.compile('{{json obj}}');
      const result = template({ obj: { user: { name: 'John', profile: { age: 30 } } } });
      expect(result).toContain('John');
      expect(result).toContain('30');
    });

    it('should stringify array', () => {
      const template = Handlebars.compile('{{json arr}}');
      const result = template({ arr: [1, 2, 3] });
      expect(result).toContain('1');
      expect(result).toContain('2');
      expect(result).toContain('3');
    });

    it('should stringify string', () => {
      const template = Handlebars.compile('{{json str}}');
      const result = template({ str: 'hello' });
      expect(result).toContain('hello');
    });

    it('should stringify number', () => {
      const template = Handlebars.compile('{{json num}}');
      const result = template({ num: 42 });
      expect(result).toBe('42');
    });

    it('should stringify boolean', () => {
      const template = Handlebars.compile('{{json flag}}');
      const result = template({ flag: true });
      expect(result).toBe('true');
    });

    it('should stringify null', () => {
      const template = Handlebars.compile('{{json val}}');
      const result = template({ val: null });
      expect(result).toBe('null');
    });

    it('should stringify undefined', () => {
      const template = Handlebars.compile('{{json val}}');
      const result = template({});
      expect(result).toBe('');
    });

    it('should handle empty object', () => {
      const template = Handlebars.compile('{{json obj}}');
      const result = template({ obj: {} });
      expect(result).toBe('{}');
    });

    it('should handle empty array', () => {
      const template = Handlebars.compile('{{json arr}}');
      const result = template({ arr: [] });
      expect(result).toBe('[]');
    });

    it('should format with indentation', () => {
      const template = Handlebars.compile('{{json obj}}');
      const result = template({ obj: { a: 1, b: 2 } });
      // Check that it's formatted (contains newlines or spaces for indentation)
      expect(result.length).toBeGreaterThan(10); // More than just {"a":1,"b":2}
    });
  });

  // ===== Integration Tests =====

  describe('renderTemplate', () => {
    it('should render simple variable substitution', () => {
      const result = renderTemplate('Hello {{name}}!', { name: 'World' });
      expect(result).toBe('Hello World!');
    });

    it('should render with arithmetic helpers', () => {
      const result = renderTemplate('Port: {{add 6000 PORT_SEED}}', { PORT_SEED: 42 });
      expect(result).toBe('Port: 6042');
    });

    it('should render with string helpers', () => {
      const result = renderTemplate('{{uppercase name}}', { name: 'hello' });
      expect(result).toBe('HELLO');
    });

    it('should render with conditional helpers in if blocks', () => {
      const result = renderTemplate('{{#if (eq status "running")}}Active{{else}}Inactive{{/if}}', {
        status: 'running',
      });
      expect(result).toBe('Active');
    });

    it('should render with nested helpers', () => {
      const result = renderTemplate('{{uppercase (replace name "-" "_")}}', {
        name: 'hello-world',
      });
      expect(result).toBe('HELLO_WORLD');
    });

    it('should render complex template with multiple helpers', () => {
      const template = `
PORT={{add 6000 worktree.unique_id}}
NAME={{replace (uppercase worktree.name) "-" "_"}}
{{#if (gt worktree.unique_id 5)}}HIGH{{else}}LOW{{/if}}
      `.trim();
      const result = renderTemplate(template, {
        worktree: { unique_id: 10, name: 'test-worktree' },
      });
      expect(result).toContain('PORT=6010');
      expect(result).toContain('NAME=TEST_WORKTREE');
      expect(result).toContain('HIGH');
    });

    it('should not throw on invalid template syntax; returns "" by default and logs', () => {
      // Default fallback is '' (safe for command/env/prompt callers); UI
      // surfaces opt into raw-template fallback via { onError: 'raw' }.
      const result = renderTemplate('{{#if unclosed', {});
      expect(result).toBe('');
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Handlebars template error'),
        expect.anything()
      );
    });

    it('should handle empty template', () => {
      const result = renderTemplate('', {});
      expect(result).toBe('');
    });

    it('should handle template with no variables', () => {
      const result = renderTemplate('Static content', {});
      expect(result).toBe('Static content');
    });

    it('should handle undefined variables gracefully', () => {
      const result = renderTemplate('Hello {{name}}!', {});
      expect(result).toBe('Hello !');
    });

    it('should handle nested object access', () => {
      const result = renderTemplate('{{user.profile.name}}', {
        user: { profile: { name: 'John' } },
      });
      expect(result).toBe('John');
    });

    it('should handle array access', () => {
      const result = renderTemplate('{{items.[0]}}', { items: ['first', 'second'] });
      expect(result).toBe('first');
    });

    it('should handle each loop with built-in helper', () => {
      const result = renderTemplate('{{#each items}}{{this}} {{/each}}', {
        items: ['a', 'b', 'c'],
      });
      expect(result).toBe('a b c ');
    });
  });

  describe('buildWorktreeContext', () => {
    it('should build basic context with all fields', () => {
      const context = buildWorktreeContext({
        worktree_unique_id: 42,
        name: 'my-worktree',
        path: '/path/to/worktree',
        repo_slug: 'my-repo',
        custom_context: { foo: 'bar' },
      });

      expect(context).toEqual({
        worktree: {
          unique_id: 42,
          name: 'my-worktree',
          path: '/path/to/worktree',
          gid: undefined,
        },
        repo: {
          slug: 'my-repo',
        },
        host: {
          ip_address: '',
        },
        custom: { foo: 'bar' },
      });
    });

    it('should expose host.ip_address when provided', () => {
      const context = buildWorktreeContext({
        worktree_unique_id: 1,
        name: 'test',
        path: '/test',
        host_ip_address: '10.0.0.5',
      });

      expect(context.host).toEqual({ ip_address: '10.0.0.5' });

      const rendered = renderTemplate('http://{{host.ip_address}}:8080/health', context);
      expect(rendered).toBe('http://10.0.0.5:8080/health');
    });

    it('should render empty string for {{host.ip_address}} when unresolved', () => {
      const context = buildWorktreeContext({
        worktree_unique_id: 1,
        name: 'test',
        path: '/test',
      });

      const rendered = renderTemplate('host={{host.ip_address}}', context);
      expect(rendered).toBe('host=');
    });

    it('should handle missing repo_slug', () => {
      const context = buildWorktreeContext({
        worktree_unique_id: 1,
        name: 'test',
        path: '/test',
      });

      expect(context.repo).toEqual({ slug: '' });
    });

    it('should handle missing custom_context', () => {
      const context = buildWorktreeContext({
        worktree_unique_id: 1,
        name: 'test',
        path: '/test',
        repo_slug: 'repo',
      });

      expect(context.custom).toEqual({});
    });

    it('should handle empty custom_context', () => {
      const context = buildWorktreeContext({
        worktree_unique_id: 1,
        name: 'test',
        path: '/test',
        repo_slug: 'repo',
        custom_context: {},
      });

      expect(context.custom).toEqual({});
    });

    it('should preserve nested custom context', () => {
      const context = buildWorktreeContext({
        worktree_unique_id: 1,
        name: 'test',
        path: '/test',
        repo_slug: 'repo',
        custom_context: {
          nested: {
            value: 123,
            array: [1, 2, 3],
          },
        },
      });

      expect(context.custom).toEqual({
        nested: {
          value: 123,
          array: [1, 2, 3],
        },
      });
    });

    it('should build context usable in templates', () => {
      const context = buildWorktreeContext({
        worktree_unique_id: 5,
        name: 'test-wt',
        path: '/path/to/test',
        repo_slug: 'test-repo',
        custom_context: { port_base: 3000 },
      });

      const result = renderTemplate(
        'Port: {{add custom.port_base worktree.unique_id}}, Name: {{worktree.name}}, Repo: {{repo.slug}}',
        context
      );
      expect(result).toBe('Port: 3005, Name: test-wt, Repo: test-repo');
    });

    it('should handle zero unique_id', () => {
      const context = buildWorktreeContext({
        worktree_unique_id: 0,
        name: 'test',
        path: '/test',
        repo_slug: 'repo',
      });

      expect((context.worktree as any).unique_id).toBe(0);
    });

    it('should handle special characters in name', () => {
      const context = buildWorktreeContext({
        worktree_unique_id: 1,
        name: 'test-worktree_123',
        path: '/test',
        repo_slug: 'repo',
      });

      expect((context.worktree as any).name).toBe('test-worktree_123');
    });

    it('should handle absolute paths', () => {
      const context = buildWorktreeContext({
        worktree_unique_id: 1,
        name: 'test',
        path: '/absolute/path/to/worktree',
        repo_slug: 'repo',
      });

      expect((context.worktree as any).path).toBe('/absolute/path/to/worktree');
    });

    it('should handle custom context with various types', () => {
      const context = buildWorktreeContext({
        worktree_unique_id: 1,
        name: 'test',
        path: '/test',
        repo_slug: 'repo',
        custom_context: {
          string: 'value',
          number: 42,
          boolean: true,
          array: [1, 2, 3],
          object: { nested: 'value' },
          null_val: null,
          undefined_val: undefined,
        },
      });

      expect(context.custom).toEqual({
        string: 'value',
        number: 42,
        boolean: true,
        array: [1, 2, 3],
        object: { nested: 'value' },
        null_val: null,
        undefined_val: undefined,
      });
    });
  });

  // ===== Helper Registration Tests =====

  describe('registerHandlebarsHelpers', () => {
    it('should register all arithmetic helpers', () => {
      registerHandlebarsHelpers();
      expect(Handlebars.compile('{{add 1 2}}')({})).toBe('3');
      expect(Handlebars.compile('{{sub 5 2}}')({})).toBe('3');
      expect(Handlebars.compile('{{mul 3 4}}')({})).toBe('12');
      expect(Handlebars.compile('{{div 10 2}}')({})).toBe('5');
      expect(Handlebars.compile('{{mod 10 3}}')({})).toBe('1');
    });

    it('should register all string helpers', () => {
      registerHandlebarsHelpers();
      expect(Handlebars.compile('{{uppercase "hello"}}')({})).toBe('HELLO');
      expect(Handlebars.compile('{{lowercase "HELLO"}}')({})).toBe('hello');
      expect(Handlebars.compile('{{replace "a-b" "-" "_"}}')({})).toBe('a_b');
    });

    it('should register all conditional helpers', () => {
      registerHandlebarsHelpers();
      expect(Handlebars.compile('{{eq 1 1}}')({})).toBe('true');
      expect(Handlebars.compile('{{neq 1 2}}')({})).toBe('true');
      expect(Handlebars.compile('{{gt 5 3}}')({})).toBe('true');
      expect(Handlebars.compile('{{lt 3 5}}')({})).toBe('true');
      expect(Handlebars.compile('{{gte 5 5}}')({})).toBe('true');
      expect(Handlebars.compile('{{lte 5 5}}')({})).toBe('true');
    });

    it('should register all utility helpers', () => {
      registerHandlebarsHelpers();
      expect(Handlebars.compile('{{default undefined "fallback"}}')({})).toBe('fallback');
      expect(Handlebars.compile('{{json obj}}')({ obj: { a: 1 } })).toContain('1');
    });

    it('should allow re-registration without errors', () => {
      registerHandlebarsHelpers();
      expect(() => registerHandlebarsHelpers()).not.toThrow();
    });
  });

  // Regression test for the zone trigger dialog rendering bug (PR #1090 + v2).
  //
  // PR #1090 swapped a direct `Handlebars.compile()` call (which used a UI-
  // local Handlebars instance with no helpers registered) for the shared
  // `renderTemplate()`. The intent was that `initializeHandlebarsHelpers()`
  // at app startup would populate helpers on the *same* instance that
  // `renderTemplate()` compiles against. That works when both modules
  // resolve to the same physical Handlebars instance, but in tsup-bundled
  // environments the bundle can capture a *separate* Handlebars instance —
  // helpers register on the host-app instance, while renderTemplate compiles
  // against the bundled instance. Templates using helpers like {{add}} then
  // throw at render time, which renderTemplate's catch-all swallowed into
  // an empty string — producing the v1 symptom of an empty modal.
  //
  // The v2 fix makes renderTemplate self-register helpers on the same
  // instance it compiles against, eliminating the dual-instance hazard.
  describe('regression: renderTemplate is self-sufficient (no prior register call)', () => {
    it('renders a helper-using template even when our helpers are absent from Handlebars at call time', async () => {
      // Reproduce the production failure mode: in the tsup-bundled
      // @agor-live/client, the Handlebars singleton renderTemplate compiles
      // against has *no* Agor helpers registered (because the host app
      // registered them on a different physical instance). Simulate that
      // here by stripping our helpers off the Handlebars singleton AND
      // re-importing the module so its `helpersRegistered` flag resets.
      const ourHelpers = [
        'add',
        'sub',
        'mul',
        'div',
        'eq',
        'ne',
        'lt',
        'lte',
        'gt',
        'gte',
        'and',
        'or',
        'not',
        'concat',
        'uppercase',
        'lowercase',
        'replace',
        'trim',
        'default',
        'json',
      ];
      const saved: Record<string, unknown> = {};
      for (const name of ourHelpers) {
        saved[name] = Handlebars.helpers[name];
        Handlebars.unregisterHelper(name);
      }
      try {
        vi.resetModules();
        const fresh = await import('./handlebars-helpers');
        const result = fresh.renderTemplate(
          'Open issue #{{add 1000 worktree.unique_id}} for {{uppercase worktree.name}}',
          { worktree: { unique_id: 90, name: 'feature-x' } }
        );
        expect(result).toBe('Open issue #1090 for FEATURE-X');
      } finally {
        // Restore helpers for downstream tests in this file (which reuse
        // the global Handlebars singleton via the top-level beforeEach).
        for (const [name, helper] of Object.entries(saved)) {
          if (helper) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            Handlebars.registerHelper(name, helper as any);
          }
        }
      }
    });

    it('renders the zone-trigger-style template the modal actually feeds in', () => {
      // Mirrors the context shape the ZoneTriggerModal builds in
      // apps/agor-ui/src/components/SessionCanvas/canvas/ZoneTriggerModal.tsx
      const template =
        'Worktree: {{worktree.name}} ({{worktree.ref}})\n' +
        'Issue: {{worktree.issue_url}}\n' +
        'Notes: {{worktree.notes}}\n' +
        'Board: {{board.name}}';
      const context = {
        worktree: {
          name: 'fix-zone-trigger',
          ref: 'fix-zone-trigger',
          issue_url: 'https://example.com/issues/123',
          pull_request_url: '',
          notes: 'render the interpolated template',
          path: '/tmp/wt',
          context: {},
        },
        board: { name: 'main', description: '', context: {} },
        session: { description: '', context: {} },
      };
      const result = renderTemplate(template, context);
      expect(result).toContain('Worktree: fix-zone-trigger (fix-zone-trigger)');
      expect(result).toContain('Issue: https://example.com/issues/123');
      expect(result).toContain('Notes: render the interpolated template');
      expect(result).toContain('Board: main');
      // Crucially, it must NOT be empty (v1 symptom) or the raw template (pre-v1).
      expect(result).not.toBe('');
      expect(result).not.toBe(template);
    });

    it('returns "" by default on render error (safe for command/env/prompt callers)', () => {
      // Unknown helpers are a runtime error. Default fallback is '' so
      // callers that compose the result into shell commands, env vars, or
      // system prompts don't leak literal {{...}} placeholders.
      const raw = '{{nonExistentHelper foo bar}}';
      const result = renderTemplate(raw, { foo: 1, bar: 2 });
      expect(result).toBe('');
    });

    it('returns the raw template on render error when onError: "raw" is set (UI preview surfaces)', () => {
      const raw = '{{nonExistentHelper foo bar}}';
      const result = renderTemplate(raw, { foo: 1, bar: 2 }, { onError: 'raw' });
      expect(result).toBe(raw);
    });
  });

  // ===== Real-world Usage Scenarios =====

  describe('real-world scenarios', () => {
    it('should handle environment config template', () => {
      const template = `
export PORT={{add 6000 worktree.unique_id}}
export DB_NAME={{replace (lowercase worktree.name) "-" "_"}}_db
export ENV={{#if (eq worktree.unique_id 1)}}production{{else}}development{{/if}}
      `.trim();

      const context = buildWorktreeContext({
        worktree_unique_id: 1,
        name: 'Main-Branch',
        path: '/path/to/worktree',
        repo_slug: 'my-repo',
      });

      const result = renderTemplate(template, context);
      expect(result).toContain('export PORT=6001');
      expect(result).toContain('export DB_NAME=main_branch_db');
      expect(result).toContain('export ENV=production');
    });

    it('should handle zone trigger template', () => {
      const template = 'docker run -p {{add 8080 worktree.unique_id}}:8080 {{repo.slug}}:latest';

      const context = buildWorktreeContext({
        worktree_unique_id: 5,
        name: 'feature-branch',
        path: '/path',
        repo_slug: 'my-app',
      });

      const result = renderTemplate(template, context);
      expect(result).toBe('docker run -p 8085:8080 my-app:latest');
    });

    it('should handle report template with custom context', () => {
      const template = `
## Worktree Report: {{uppercase worktree.name}}

**Unique ID:** {{worktree.unique_id}}
**Path:** {{worktree.path}}
**Repository:** {{repo.slug}}
**Custom Port:** {{default custom.port 3000}}
**Status:** {{#if (gte worktree.unique_id 10)}}High Usage{{else}}Normal{{/if}}
      `.trim();

      const context = buildWorktreeContext({
        worktree_unique_id: 15,
        name: 'test-worktree',
        path: '/workspace/test',
        repo_slug: 'test-repo',
        custom_context: { port: 4000 },
      });

      const result = renderTemplate(template, context);
      expect(result).toContain('## Worktree Report: TEST-WORKTREE');
      expect(result).toContain('**Unique ID:** 15');
      expect(result).toContain('**Path:** /workspace/test');
      expect(result).toContain('**Repository:** test-repo');
      expect(result).toContain('**Custom Port:** 4000');
      expect(result).toContain('**Status:** High Usage');
    });

    it('should handle complex arithmetic in templates', () => {
      const template = '{{add (mul worktree.unique_id 100) (div custom.offset 2)}}';

      const context = buildWorktreeContext({
        worktree_unique_id: 5,
        name: 'test',
        path: '/test',
        custom_context: { offset: 10 },
      });

      const result = renderTemplate(template, context);
      expect(result).toBe('505');
    });

    it('should handle conditional chains', () => {
      const template = `
{{#if (gt worktree.unique_id 100)}}
  Very High
{{else}}
  {{#if (gt worktree.unique_id 50)}}
    High
  {{else}}
    {{#if (gt worktree.unique_id 10)}}
      Medium
    {{else}}
      Low
    {{/if}}
  {{/if}}
{{/if}}
      `.trim();

      const context = buildWorktreeContext({
        worktree_unique_id: 25,
        name: 'test',
        path: '/test',
      });

      const result = renderTemplate(template, context).trim();
      expect(result).toContain('Medium');
    });
  });
});
