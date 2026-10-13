import { z } from 'zod';

/**
 * Password policy, applied wherever a password is set: length beats
 * composition rules, but a mixed-character minimum still filters the worst
 * choices without pushing people to "Password1!".
 */
export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters.')
  .max(128, 'Password must be at most 128 characters.')
  .refine((v) => /[a-z]/.test(v), 'Password must contain a lowercase letter.')
  .refine((v) => /[A-Z]/.test(v), 'Password must contain an uppercase letter.')
  .refine((v) => /[0-9]/.test(v), 'Password must contain a number.');

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(191),
  password: z.string().min(1, 'Password is required.').max(128),
});

/** A six-digit app code ("123 456" is fine) or a 5-5 recovery code. */
export const mfaCodeSchema = z.string().trim().min(6, 'Enter the code from your authenticator app.').max(20);

export const mfaLoginSchema = z.object({
  mfa_token: z.string().min(20, 'The sign-in attempt is missing.').max(2048),
  code: mfaCodeSchema,
});

export const refreshSchema = z.object({
  refresh_token: z.string().min(32, 'Refresh token is required.').max(256),
});

export const changePasswordSchema = z
  .object({
    current_password: z.string().min(1, 'Current password is required.'),
    new_password: passwordSchema,
  })
  .refine((d) => d.current_password !== d.new_password, {
    message: 'New password must differ from the current one.',
    path: ['new_password'],
  });

export const idParamSchema = z.object({
  id: z.coerce.number().int().positive('Invalid id.'),
});
