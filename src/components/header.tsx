'use client';

import { Flex, Heading, Link } from '@radix-ui/themes';

export default function Header() {
    return (
        <Flex px="4" py="2" justify="between" align="center">
            <Link href="/" className="no-underline">
                <Heading as="h1" size="7">
                    AI LinkedIn
                </Heading>
            </Link>
        </Flex>
    );
}
