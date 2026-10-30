import type { FeatureAnnouncementItemDTO, User } from '@agor-live/client';
import { GiftOutlined, LeftOutlined, RightOutlined } from '@ant-design/icons';
import type { GetRef } from 'antd';
import { Button, Carousel, ConfigProvider, Flex, Modal, Tag, Typography, theme } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTheme } from '../../contexts/ThemeContext';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import { useFeatureAnnouncements } from './FeatureAnnouncementsContext';
import { resolveCtaPath } from './featureAnnouncementsLinks';

const Slide: React.FC<{ item: FeatureAnnouncementItemDTO }> = ({ item }) => {
  const { token } = theme.useToken();
  const { isDark } = useTheme();
  const [visualFailed, setVisualFailed] = useState(false);
  const visual = (isDark ? item.visual_url_dark : item.visual_url) ?? item.visual_url;
  return (
    <Flex vertical gap={token.marginSM}>
      <Tag
        icon={<GiftOutlined />}
        color="processing"
        variant="filled"
        style={{ alignSelf: 'flex-start', borderRadius: token.borderRadiusLG }}
      >
        New in Agor
      </Tag>
      <Typography.Title level={3} style={{ margin: 0 }}>
        {item.title}
      </Typography.Title>
      {item.subtitle && <Typography.Text type="secondary">{item.subtitle}</Typography.Text>}
      {visual && !visualFailed && (
        <img
          src={visual}
          alt=""
          onError={() => setVisualFailed(true)}
          style={{
            width: '100%',
            aspectRatio: '2 / 1',
            objectFit: 'cover',
            borderRadius: token.borderRadiusLG,
            border: `1px solid ${token.colorBorderSecondary}`,
          }}
        />
      )}
    </Flex>
  );
};

/**
 * Announces major updates the user has not seen, newest first, one slide
 * each. Any way out marks every slide seen, so the same items never return.
 */
export const WhatsNewModal: React.FC<{ user: User | null; suppressed: boolean }> = ({
  user,
  suppressed,
}) => {
  const { token } = theme.useToken();
  const navigate = useNavigate();
  const reducedMotion = usePrefersReducedMotion();
  const featureAnnouncements = useFeatureAnnouncements();
  const carousel = useRef<GetRef<typeof Carousel>>(null);
  const [index, setIndex] = useState(0);
  // Freeze the slides while open: marking them seen must not reshuffle the carousel.
  const [slides, setSlides] = useState<FeatureAnnouncementItemDTO[]>([]);
  const pending = featureAnnouncements?.feed?.pending_major_items ?? [];
  const open = slides.length > 0;

  useEffect(() => {
    if (!open && !suppressed && pending.length > 0) {
      setIndex(0);
      setSlides(pending);
    }
  }, [open, suppressed, pending]);

  if (!featureAnnouncements) return null;
  const current = slides[index];
  const ctaPath = current?.cta_label ? resolveCtaPath(current.cta_path, user) : null;
  const close = () => {
    featureAnnouncements.markMajorsSeen(slides.map((item) => item.id));
    setSlides([]);
  };

  return (
    <Modal
      open={open && !suppressed}
      onCancel={close}
      width={560}
      centered
      destroyOnHidden
      footer={
        <Flex align="center" justify="space-between" gap={token.marginSM} wrap>
          <Button
            type="text"
            onClick={() => {
              close();
              featureAnnouncements.openDrawer();
            }}
          >
            All updates
          </Button>
          <Flex gap={token.marginXS} wrap>
            <Button onClick={close}>Not now</Button>
            {ctaPath && (
              <Button
                type="primary"
                onClick={() => {
                  close();
                  navigate(ctaPath);
                }}
              >
                {current.cta_label}
              </Button>
            )}
          </Flex>
        </Flex>
      }
    >
      {/* Carousel dots paint with colorBgContainer, invisible on a modal surface. */}
      <ConfigProvider theme={{ components: { Carousel: { colorBgContainer: token.colorText } } }}>
        <Carousel
          ref={carousel}
          dots={slides.length > 1}
          // Fade keeps a neighbour's visual from bleeding in; a text-only slide stays short.
          effect="fade"
          adaptiveHeight
          infinite={false}
          speed={reducedMotion ? 0 : 300}
          beforeChange={(_from, to) => setIndex(to)}
          style={{ paddingBottom: slides.length > 1 ? token.paddingLG : 0 }}
        >
          {slides.map((item) => (
            <div key={item.id}>
              <Slide item={item} />
            </div>
          ))}
        </Carousel>
      </ConfigProvider>
      {slides.length > 1 && (
        <Flex align="center" justify="space-between">
          <Button
            type="text"
            icon={<LeftOutlined />}
            disabled={index === 0}
            onClick={() => carousel.current?.prev()}
          >
            Back
          </Button>
          <Typography.Text type="secondary" aria-live="polite">
            {index + 1} of {slides.length}
          </Typography.Text>
          <Button
            type="text"
            icon={<RightOutlined />}
            iconPlacement="end"
            disabled={index === slides.length - 1}
            onClick={() => carousel.current?.next()}
          >
            Next
          </Button>
        </Flex>
      )}
    </Modal>
  );
};
