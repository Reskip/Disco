/**
 * `disco user update` - Update a user
 */

import type { User } from '@disco-live/client';
import { shortId } from '@disco-live/client';
import { Args, Flags } from '@oclif/core';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { BaseCommand } from '../../base-command';

export default class UserUpdate extends BaseCommand {
  static description = 'Update a user account';

  static examples = [
    '<%= config.bin %> <%= command.id %> alice --name "New Name"',
    '<%= config.bin %> <%= command.id %> 0199d1bd --role member',
    '<%= config.bin %> <%= command.id %> alice --password newpassword123',
    '<%= config.bin %> <%= command.id %> alice --unix-username testuser',
    '<%= config.bin %> <%= command.id %> 0199d1bd --force-password-change',
  ];

  static args = {
    user: Args.string({
      description: 'Username or user ID',
      required: true,
    }),
  };

  static flags = {
    username: Flags.string({
      description: 'New username',
    }),
    name: Flags.string({
      description: 'New name',
    }),
    password: Flags.string({
      description: 'New password (will prompt if not provided)',
    }),
    role: Flags.string({
      description: 'New role',
      options: ['superadmin', 'admin', 'member', 'viewer'],
    }),
    'unix-username': Flags.string({
      description: 'New Execution home key for shell access',
    }),
    'filesystem-home': Flags.string({
      description:
        'Absolute host home dir for the per-user sandbox overlay (unix_user_mode: sandbox). Admin-only.',
    }),
    'force-password-change': Flags.boolean({
      description: 'Force user to change password on next login (omit to leave unchanged)',
      allowNo: true, // Allows --no-force-password-change to clear the flag
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(UserUpdate);
    const client = await this.connectToDaemon();

    try {
      // Find user by username or ID
      const usersService = client.service('users');
      const users = await usersService.findAll();

      const user = users.find(
        (u) =>
          u.username === args.user || u.user_id === args.user || u.user_id.startsWith(args.user)
      );

      if (!user) {
        await this.cleanupClient(client);
        this.error(
          `${chalk.red('✗ User not found')}\n${chalk.gray(`  No user matching: ${args.user}`)}`
        );
      }

      // If no flags provided, prompt for what to update
      if (
        !flags.username &&
        !flags.name &&
        !flags.password &&
        !flags.role &&
        !flags['unix-username'] &&
        flags['force-password-change'] === undefined
      ) {
        const { fields } = await inquirer.prompt([
          {
            type: 'checkbox',
            name: 'fields',
            message: 'What would you like to update?',
            choices: [
              { name: 'Username', value: 'username' },
              { name: 'Name', value: 'name' },
              { name: 'Password', value: 'password' },
              { name: 'Role', value: 'role' },
              { name: 'Execution Home Key', value: 'unix_username' },
              { name: 'Force Password Change', value: 'force_password_change' },
            ],
          },
        ]);

        if (fields.length === 0) {
          this.log(chalk.gray('No changes selected'));
          await this.cleanupClient(client);
          return;
        }

        // Prompt for each selected field
        const answers = await inquirer.prompt([
          {
            type: 'input',
            name: 'username',
            message: 'New username:',
            when: fields.includes('username'),
            default: user.username,
            validate: (input: string) => {
              if (!input?.trim()) return 'Username is required';
              return true;
            },
          },
          {
            type: 'input',
            name: 'name',
            message: 'New name:',
            when: fields.includes('name'),
            default: user.name,
          },
          {
            type: 'password',
            name: 'password',
            message: 'New password:',
            when: fields.includes('password'),
            validate: (input: string) => {
              if (!input) return 'Password is required';
              if (input.length < 8) return 'Password must be at least 8 characters';
              return true;
            },
            mask: '*',
          },
          {
            type: 'list',
            name: 'role',
            message: 'New role:',
            when: fields.includes('role'),
            choices: ['superadmin', 'admin', 'member', 'viewer'],
            default: user.role,
          },
          {
            type: 'input',
            name: 'unix_username',
            message: 'New Execution home key:',
            when: fields.includes('unix_username'),
            default: user.unix_username,
          },
          {
            type: 'confirm',
            name: 'force_password_change',
            message: 'Force user to change password on next login?',
            when: fields.includes('force_password_change'),
            default: user.must_change_password,
          },
        ]);

        // Apply answers to flags
        if (answers.username) flags.username = answers.username;
        if (answers.name) flags.name = answers.name;
        if (answers.password) flags.password = answers.password;
        if (answers.role) flags.role = answers.role;
        if (answers.unix_username) flags['unix-username'] = answers.unix_username;
        if (answers.force_password_change !== undefined)
          flags['force-password-change'] = answers.force_password_change;
      }

      // Build update object
      const updates: Partial<User> & {
        password?: string;
        must_change_password?: boolean;
        unix_username?: string;
        filesystem_home?: string;
      } = {};
      if (flags.username) updates.username = flags.username;
      if (flags.name) updates.name = flags.name;
      if (flags.password) updates.password = flags.password;
      if (flags.role) updates.role = flags.role as 'superadmin' | 'admin' | 'member' | 'viewer';
      if (flags['unix-username']) updates.unix_username = flags['unix-username'];
      if (flags['filesystem-home']) updates.filesystem_home = flags['filesystem-home'];
      if (flags['force-password-change'] !== undefined) {
        updates.must_change_password = flags['force-password-change'];
      }

      if (Object.keys(updates).length === 0) {
        this.log(chalk.gray('No changes to apply'));
        await this.cleanupClient(client);
        return;
      }

      // Update user
      this.log('');
      this.log(chalk.gray('Updating user...'));
      const updatedUser = await usersService.patch(user.user_id, updates);

      this.log(`${chalk.green('✓')} User updated successfully`);
      this.log('');
      this.log(`  Username:      ${chalk.cyan(updatedUser.username)}`);
      this.log(`  Name:          ${chalk.cyan(updatedUser.name || '(not set)')}`);
      this.log(`  Role:          ${chalk.cyan(updatedUser.role)}`);
      this.log(`  Execution Home Key: ${chalk.cyan(updatedUser.unix_username || '(not set)')}`);
      this.log(`  ID:            ${chalk.gray(shortId(updatedUser.user_id))}`);
      if (updatedUser.must_change_password) {
        this.log(`  ${chalk.yellow('⚠')} User must change password on next login`);
      }

      await this.cleanupClient(client);
    } catch (error) {
      await this.cleanupClient(client);
      this.error(
        `${chalk.red('✗ Failed to update user')}\n${chalk.red(`  ${error instanceof Error ? error.message : String(error)}`)}`
      );
    }
  }
}
