// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
	integrations: [
		starlight({
			title: 'protestchat',
			description:
				'Off-grid messaging for internet shutdowns and jammed protests — plain-language user guide.',
			social: [
				{
					icon: 'github',
					label: 'GitHub',
					href: 'https://github.com/ni5arga/protestchat',
				},
			],
			editLink: {
				baseUrl: 'https://github.com/ni5arga/protestchat/edit/main/website/',
			},
			sidebar: [
				{ label: 'Start here', slug: 'index' },
				{ label: 'Get running (5 minutes)', slug: 'get-started' },
				{ label: 'Four ways to send', slug: 'modes' },
				{ label: 'Your responsibility', slug: 'responsibility' },
				{ label: 'What this will not do', slug: 'limits' },
			],
		}),
	],
});
