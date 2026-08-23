/**
 * THROWAWAY test screen — recreates a green banking-dashboard mockup as working
 * React Native. Not wired to any real data; every value is hardcoded. Delete
 * once the design experiment is done. Route: /demo-dashboard
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { LinearGradient } from 'expo-linear-gradient';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

const C = {
  greenTop: '#1F5F45',
  greenBottom: '#0E3A28',
  white: '#FFFFFF',
  ink: '#101511',
  muted: '#7A857E',
  faint: '#A7B0AA',
  hair: '#EEF1EF',
  red: '#E5484D',
  green: '#149E5A',
  chipDark: 'rgba(255,255,255,0.14)',
};

type Txn = {
  key: string;
  name: string;
  meta: string;
  amount: string;
  positive?: boolean;
  declined?: boolean;
  icon: keyof typeof Ionicons.glyphMap;
  iconBg: string;
  iconColor: string;
};

const SECTIONS: { label: string; rows: Txn[] }[] = [
  {
    label: 'TODAY',
    rows: [
      {
        key: 'apple',
        name: 'Apple.Com/Bill',
        meta: '08:14 AM',
        amount: '-$37.49',
        declined: true,
        icon: 'logo-apple',
        iconBg: '#111111',
        iconColor: '#FFFFFF',
      },
    ],
  },
  {
    label: 'YESTERDAY',
    rows: [
      {
        key: 'salary',
        name: 'Salary Deposit',
        meta: '4:15 PM',
        amount: '+$3,400.00',
        positive: true,
        icon: 'arrow-down',
        iconBg: '#E6F5EC',
        iconColor: C.green,
      },
    ],
  },
  {
    label: 'THIS WEEK',
    rows: [
      {
        key: 'netflix',
        name: 'Netflix Subscription',
        meta: '18 Aug 2026',
        amount: '-$15.49',
        icon: 'play',
        iconBg: '#FBE9E9',
        iconColor: '#E50914',
      },
      {
        key: 'starbucks',
        name: 'Starbucks Coffee',
        meta: '17 Aug 2026',
        amount: '-$6.50',
        icon: 'cafe',
        iconBg: '#E6F2EC',
        iconColor: '#0B6B3A',
      },
    ],
  },
];

function CircleButton({
  icon,
  onDark,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  onDark?: boolean;
}) {
  return (
    <View style={[styles.circleBtn, onDark && styles.circleBtnDark]}>
      <Ionicons name={icon} size={18} color={C.white} />
    </View>
  );
}

function TxnRow({ row }: { row: Txn }) {
  const amountColor = row.declined || row.amount.startsWith('-') ? C.red : C.green;
  return (
    <View style={styles.txnRow}>
      <View style={[styles.txnIcon, { backgroundColor: row.iconBg }]}>
        <Ionicons name={row.icon} size={18} color={row.iconColor} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.txnName}>{row.name}</Text>
        <Text style={styles.txnMeta}>{row.meta}</Text>
      </View>
      <View style={{ alignItems: 'flex-end' }}>
        <Text style={[styles.txnAmount, { color: amountColor }]}>{row.amount}</Text>
        {row.declined ? <Text style={styles.declined}>Declined</Text> : null}
      </View>
    </View>
  );
}

export default function DemoDashboard() {
  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
      <ScrollView showsVerticalScrollIndicator={false}>
        <LinearGradient
          colors={[C.greenTop, C.greenBottom]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.hero}
        >
          <View style={styles.heroTopRow}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <View style={styles.avatar}>
                <Ionicons name="leaf" size={18} color={C.white} />
              </View>
              <View>
                <Text style={styles.hi}>Hi, Tega</Text>
                <Text style={styles.greeting}>Good morning</Text>
              </View>
            </View>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <CircleButton icon="scan-outline" />
              <CircleButton icon="grid-outline" />
            </View>
          </View>

          <View style={styles.accountPill}>
            <Text style={styles.flag}>🇺🇸</Text>
            <Text style={styles.accountText}>USD Account ••• 6372</Text>
            <Ionicons name="chevron-down" size={16} color={C.white} />
          </View>

          <View style={styles.balanceLabelRow}>
            <Text style={styles.balanceLabel}>Available balance</Text>
            <Ionicons name="eye-outline" size={14} color="rgba(255,255,255,0.7)" />
          </View>
          <Text style={styles.balance}>$1,850.00</Text>

          <View style={styles.actionsRow}>
            <View style={styles.addMoney}>
              <Ionicons name="add" size={18} color={C.ink} />
              <Text style={styles.addMoneyText}>Add money</Text>
            </View>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <CircleButton icon="arrow-up" onDark />
              <CircleButton icon="swap-horizontal" onDark />
              <CircleButton icon="ellipsis-horizontal" onDark />
            </View>
          </View>
        </LinearGradient>

        <View style={styles.body}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Recent transactions</Text>
            <Text style={styles.seeAll}>See all</Text>
          </View>

          {SECTIONS.map((section) => (
            <View key={section.label}>
              <Text style={styles.groupLabel}>{section.label}</Text>
              {section.rows.map((row) => (
                <TxnRow key={row.key} row={row} />
              ))}
            </View>
          ))}
        </View>
      </ScrollView>

      <View style={styles.tabBar}>
        {[
          { icon: 'home', label: 'Home', active: true },
          { icon: 'card-outline', label: 'Cards' },
          { icon: 'trending-up-outline', label: 'Invest' },
          { icon: 'business-outline', label: 'Accounts' },
        ].map((tab) => (
          <View key={tab.label} style={styles.tab}>
            <Ionicons
              name={tab.icon as keyof typeof Ionicons.glyphMap}
              size={22}
              color={tab.active ? C.green : C.faint}
            />
            <Text style={[styles.tabLabel, tab.active && { color: C.green }]}>{tab.label}</Text>
          </View>
        ))}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.white },
  hero: {
    marginHorizontal: 12,
    marginTop: 6,
    borderRadius: 28,
    padding: 20,
    paddingBottom: 22,
  },
  heroTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  hi: { color: C.white, fontSize: 16, fontWeight: '700' },
  greeting: { color: 'rgba(255,255,255,0.75)', fontSize: 13 },
  circleBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(255,255,255,0.16)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  circleBtnDark: { backgroundColor: 'rgba(0,0,0,0.28)' },
  accountPill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    gap: 8,
    backgroundColor: C.chipDark,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    marginTop: 22,
  },
  flag: { fontSize: 15 },
  accountText: { color: C.white, fontSize: 13, fontWeight: '600' },
  balanceLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: 18,
  },
  balanceLabel: { color: 'rgba(255,255,255,0.75)', fontSize: 13 },
  balance: {
    color: C.white,
    fontSize: 38,
    fontWeight: '800',
    textAlign: 'center',
    marginTop: 4,
    letterSpacing: 0.5,
  },
  actionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 22,
  },
  addMoney: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: C.white,
    paddingHorizontal: 16,
    paddingVertical: 11,
    borderRadius: 999,
  },
  addMoneyText: { color: C.ink, fontSize: 14, fontWeight: '700' },
  body: { paddingHorizontal: 20, paddingTop: 22 },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  sectionTitle: { color: C.ink, fontSize: 16, fontWeight: '700' },
  seeAll: { color: C.green, fontSize: 13, fontWeight: '600' },
  groupLabel: {
    color: C.faint,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    marginTop: 16,
    marginBottom: 4,
  },
  txnRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, gap: 12 },
  txnIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  txnName: { color: C.ink, fontSize: 15, fontWeight: '600' },
  txnMeta: { color: C.muted, fontSize: 12, marginTop: 2 },
  txnAmount: { fontSize: 15, fontWeight: '700' },
  declined: { color: C.red, fontSize: 11, marginTop: 2, fontWeight: '600' },
  tabBar: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.hair,
    paddingTop: 8,
    paddingBottom: 4,
  },
  tab: { flex: 1, alignItems: 'center', gap: 3 },
  tabLabel: { color: C.faint, fontSize: 11, fontWeight: '600' },
});
