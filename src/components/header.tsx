import { Flex, Heading, Link, Button } from '@radix-ui/themes';
import { createClient } from '@/utils/supabase/server';
import { signOut } from '@/app/login/actions';

export default async function Header() {
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();

    return (
        <Flex px="4" py="2" justify="between" align="center">
            <Link href="/" className="no-underline">
                <Heading as="h1" size="7">
                    unlinked.ai
                </Heading>
            </Link>

            <Flex align="center" gap="4">
                {data.user ? (
                    <Flex align="center" gap="4">
                        <span>{data.user.email}</span>
                        <form>
                            <Button
                                size="2"
                                variant="soft"
                                formAction={signOut}
                            >
                                Sign out
                            </Button>
                        </form>
                    </Flex>
                ) : (
                    <Link href="/login">
                        <Button size="2" variant="soft">
                            Sign in
                        </Button>
                    </Link>
                )}
            </Flex>
        </Flex>
    );
}
